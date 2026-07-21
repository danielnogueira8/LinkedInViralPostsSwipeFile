/**
 * Debug: inspect agent-loop state per workspace (opportunities, system chat,
 * messages, board drafts). Read-only.
 *
 *   npx tsx --env-file=.env.local scripts/debug-agent-state.ts
 */

import { supabaseAdmin } from "@/lib/supabase";

async function main() {
  const sb = supabaseAdmin();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: opportunities, error } = await sb
    .from("agent_opportunities")
    .select("workspace_id, id, status, score, payload, created_at, acted_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const byWorkspace = new Map<string, typeof opportunities>();
  for (const opp of opportunities ?? []) {
    const list = byWorkspace.get(opp.workspace_id) ?? [];
    list.push(opp);
    byWorkspace.set(opp.workspace_id, list);
  }

  for (const [workspaceId, opps] of byWorkspace) {
    console.log(`\n=== ${workspaceId} ===`);
    for (const opp of opps ?? []) {
      const headline =
        typeof opp.payload?.headline === "string"
          ? opp.payload.headline.slice(0, 80)
          : "";
      console.log(
        `  ${opp.status.padEnd(9)} ${opp.id} score=${opp.score} acted_at=${opp.acted_at ?? "-"} ${headline}`,
      );
    }

    const { data: chat } = await sb
      .from("chats")
      .select("id, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("title", "Your agent")
      .is("archived_at", null)
      .maybeSingle();
    if (!chat) {
      console.log("  no 'Your agent' chat");
      continue;
    }
    console.log(`  chat ${chat.id} updated_at=${chat.updated_at}`);

    const { count: messageCount } = await sb
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("chat_id", chat.id);
    console.log(`  messages: ${messageCount ?? 0}`);

    const { data: latestAssistant } = await sb
      .from("chat_messages")
      .select("id, created_at, artifacts, content")
      .eq("chat_id", chat.id)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestAssistant) {
      const artifacts = Array.isArray(latestAssistant.artifacts)
        ? latestAssistant.artifacts
        : [];
      console.log(
        `  latest assistant ${latestAssistant.created_at} artifacts=${artifacts.length} content=${(latestAssistant.content ?? "").slice(0, 60)}`,
      );
    } else {
      console.log("  no assistant messages");
    }

    const { count: boardCount } = await sb
      .from("chat_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("chat_id", chat.id);
    console.log(`  board drafts from this chat: ${boardCount ?? 0}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
