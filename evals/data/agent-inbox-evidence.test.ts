import { describe, test, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAgentInboxEvidenceLoader } from "@/lib/agent-inbox/evidence";

// The legacy artifact pipeline titled drafts with the body's first 60 chars
// sliced mid-word ("…before your content ge"), and the evidence loader
// re-sliced bodies mid-sentence ("…analytics. Here's"). Both fragments landed
// verbatim in the draft prompt (lib/agent-inbox/prompt.ts). These tests pin
// the word/sentence-boundary behavior that replaced the raw slices.

const PROFILE_BODY =
  "Your LinkedIn profile can kill a sale before your content gets a chance. I don't hide behind a clever headline. I don't fill my About section with empty claims. I don't send profile visitors hunting for the offer. And you don't need to either; your profile only needs to: 1. Name the buyer you help. 2. Explain the problem you solve. 3. Show why they should trust you. 4. Give them one clear next step. That's how profile views turn into DMs instead of disappearing into LinkedIn's analytics. Here's the rest of the post that should never dangle into the prompt.";

function mockDb(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const query: Record<string, unknown> = {
        select: () => query,
        eq: () => query,
        neq: () => query,
        gte: () => query,
        gt: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

async function loadRecent(rows: Array<Record<string, unknown>>) {
  const loader = createAgentInboxEvidenceLoader(
    mockDb({ chat_artifacts: rows }),
  );
  const bundle = await loader({
    workspaceId: "ws-1",
    preferences: { topics: [], newsSensitivity: "medium" } as never,
    missingLanes: [],
    now: new Date("2026-07-28T12:00:00Z"),
  });
  return bundle.recent ?? [];
}

describe("agent inbox evidence — recent posts", () => {
  test("recovers a legacy mid-word-truncated title from the body", async () => {
    const [entry] = await loadRecent([
      {
        id: "art-1",
        title: "Your LinkedIn profile can kill a sale before your content ge",
        body: PROFILE_BODY,
        created_at: "2026-07-20T10:00:00Z",
      },
    ]);
    expect(entry.label).toBe(
      "Your LinkedIn profile can kill a sale before your content gets a chance.",
    );
  });

  test("keeps a custom title that is not a prefix of the body", async () => {
    const [entry] = await loadRecent([
      {
        id: "art-2",
        title: "Profile teardown framework",
        body: PROFILE_BODY,
        created_at: "2026-07-20T10:00:00Z",
      },
    ]);
    expect(entry.label).toBe("Profile teardown framework");
  });

  test("the detail ends at a sentence boundary — no dangling opener", async () => {
    const [entry] = await loadRecent([
      {
        id: "art-3",
        title: "Custom name",
        body: PROFILE_BODY,
        created_at: "2026-07-20T10:00:00Z",
      },
    ]);
    expect(entry.detail.length).toBeLessThanOrEqual(500);
    expect(entry.detail.endsWith("Here's")).toBe(false);
    expect(/[.!?…]$/.test(entry.detail)).toBe(true);
  });

  test("falls back to the body's first line when there is no title", async () => {
    const [entry] = await loadRecent([
      {
        id: "art-4",
        title: null,
        body: "Short opening line.\n\nThe rest of the post.",
        created_at: "2026-07-20T10:00:00Z",
      },
    ]);
    expect(entry.label).toBe("Short opening line.");
  });
});
