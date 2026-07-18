import { expect, test, type Page } from "@playwright/test";

const runLive = process.env.RUN_LIVE_COST_RECONCILIATION === "1";
const maybe = runLive ? test.describe : test.describe.skip;

maybe("live OpenRouter task-cost reconciliation", () => {
  test.describe.configure({ mode: "serial" });

  test("persisted task cost matches the OpenRouter account usage delta", async ({ page }) => {
    test.setTimeout(180_000);
    const apiKey = process.env.OPENROUTER_API_KEY;
    expect(apiKey, "OPENROUTER_API_KEY is required for the live cost probe").toBeTruthy();

    await page.goto("/dashboard");
    const usageBefore = await readOpenRouterAccountUsage(apiKey!);
    const chatId = await createChat(page);

    try {
      const stream = await page.evaluate(async (id) => {
        const response = await fetch(`/api/chats/${id}/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message:
              "Write one short LinkedIn post about why explicit handoffs make teams faster. Do not ask questions.",
            clientTurnId: crypto.randomUUID(),
            clientTimezone: "UTC",
          }),
        });
        return { status: response.status, body: await response.text() };
      }, chatId);
      expect(stream.status).toBe(200);
      expect(stream.body).toContain("event: done");

      const persistedCost = await readPersistedTurnCost(page, chatId);
      expect(persistedCost).toBeGreaterThan(0);
      const ledgerCost = await readTaskLedgerCost(chatId);
      expect(Math.abs(ledgerCost - persistedCost)).toBeLessThanOrEqual(0.00000001);

      const tolerance = Math.max(0.0005, persistedCost * 0.05);
      await expect
        .poll(
          async () => (await readOpenRouterAccountUsage(apiKey!)) - usageBefore,
          { timeout: 60_000 },
        )
        .toBeGreaterThanOrEqual(persistedCost - tolerance);
      const usageAfter = await readOpenRouterAccountUsage(apiKey!);
      const providerDelta = usageAfter - usageBefore;

      console.log(
        JSON.stringify({
          live_cost_reconciliation: {
            persisted_task_cost_usd: Number(persistedCost.toFixed(8)),
            app_usage_ledger_cost_usd: Number(ledgerCost.toFixed(8)),
            openrouter_usage_delta_usd: Number(providerDelta.toFixed(8)),
            difference_usd: Number((providerDelta - persistedCost).toFixed(8)),
            tolerance_usd: Number(tolerance.toFixed(8)),
          },
        }),
      );
      expect(providerDelta).toBeGreaterThanOrEqual(persistedCost - tolerance);
    } finally {
      await page.evaluate(async (id) => {
        await fetch(`/api/chats/${id}`, { method: "DELETE" });
      }, chatId);
    }
  });
});

async function createChat(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/chats", { method: "POST" });
    const payload = await response.json();
    if (!response.ok || !payload?.chat?.id) throw new Error("Failed to create live cost chat");
    return payload.chat.id as string;
  });
}

async function readPersistedTurnCost(page: Page, chatId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/chats/${id}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error("Failed to read live cost chat");
    const assistant = [...(payload.messages ?? [])]
      .reverse()
      .find((message: { role?: string }) => message.role === "assistant");
    const marker = (assistant?.tool_calls ?? []).find(
      (call: { function?: { name?: string } }) => call.function?.name === "_turn_usage",
    );
    const parsed = JSON.parse(marker?.function?.arguments ?? "null");
    if (!Number.isFinite(parsed?.total_cost_usd)) {
      throw new Error("Assistant turn omitted persisted cost metadata");
    }
    return parsed.total_cost_usd as number;
  }, chatId);
}

async function readOpenRouterAccountUsage(apiKey: string): Promise<number> {
  const response = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`OpenRouter account usage failed (${response.status})`);
  const payload = await response.json() as { data?: { total_usage?: unknown } };
  const usage = payload.data?.total_usage;
  if (typeof usage !== "number" || !Number.isFinite(usage)) {
    throw new Error("OpenRouter account usage response omitted total_usage");
  }
  return usage;
}

async function readTaskLedgerCost(chatId: string): Promise<number> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase E2E credentials are missing");
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${url}/rest/v1/${path}`, { headers });
    if (!response.ok) throw new Error(`Supabase live cost read failed (${response.status})`);
    return response.json() as Promise<T>;
  };
  const chatQuery = new URLSearchParams({
    id: `eq.${chatId}`,
    select: "workspace_id,created_at",
    limit: "1",
  });
  const chat = (await read<Array<{ workspace_id: string; created_at: string }>>(
    `chats?${chatQuery}`,
  ))[0];
  if (!chat) throw new Error("Live cost chat disappeared");
  const messageQuery = new URLSearchParams({
    chat_id: `eq.${chatId}`,
    role: "eq.assistant",
    select: "created_at",
    order: "created_at.desc",
    limit: "1",
  });
  const assistant = (await read<Array<{ created_at: string }>>(
    `chat_messages?${messageQuery}`,
  ))[0];
  if (!assistant) throw new Error("Live cost assistant message disappeared");
  const eventQuery = new URLSearchParams({
    workspace_id: `eq.${chat.workspace_id}`,
    provider: "eq.openrouter",
    ts: `gte.${new Date(new Date(chat.created_at).getTime() - 5_000).toISOString()}`,
    select: "cost_usd,ts",
  });
  const upperBound = new Date(new Date(assistant.created_at).getTime() + 5_000).toISOString();
  const events = await read<Array<{ cost_usd: number; ts: string }>>(
    `usage_events?${eventQuery}`,
  );
  return events
    .filter((event) => event.ts <= upperBound)
    .reduce((sum, event) => sum + Number(event.cost_usd || 0), 0);
}
