import { describe, test, expect, vi } from "vitest";
import { createTemplateResource } from "@/lib/content-resource-operations";
import { TEMPLATES_PER_WORKSPACE_MAX } from "@/lib/templates";

// ---------------------------------------------------------------------------
// createTemplateResource used to enforce the per-workspace template cap as
// TWO separate round trips: a SELECT count, then (if under the limit) an
// INSERT. Two concurrent creates can both read a below-cap count before
// either insert lands, so both proceed — a classic TOCTOU race that lets
// concurrent requests collectively exceed TEMPLATES_PER_WORKSPACE_MAX.
//
// Fixed via claim_content_template_slot (migration 100): a single RPC that
// takes a per-workspace advisory lock and counts+inserts INSIDE it, so the
// count and insert are atomic — no app-level race window. These tests verify
// the TypeScript side calls the RPC correctly and interprets both outcomes
// (`over_cap: true` vs a real row) without a second network round trip.
// ---------------------------------------------------------------------------

function fakeDb(rpcResult: { data: unknown; error: unknown }) {
  const rpcSpy = vi.fn(() => ({
    single: async () => rpcResult,
  }));
  return { rpc: rpcSpy } as unknown as Parameters<typeof createTemplateResource>[0]["db"];
}

describe("createTemplateResource — atomic cap via claim_content_template_slot", () => {
  test("under the cap: calls the RPC once and returns the inserted row", async () => {
    const row = {
      id: "t1",
      workspace_id: "ws1",
      title: "My template",
      category: "story",
      body: "Body {placeholder}",
      source: "custom",
      origin_post_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      over_cap: false,
    };
    const db = fakeDb({ data: row, error: null });
    const result = await createTemplateResource({
      db,
      workspaceId: "ws1",
      data: { title: "My template", category: "story", body: "Body {placeholder}" },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        id: "t1",
        workspace_id: "ws1",
        title: "My template",
        category: "story",
        body: "Body {placeholder}",
        source: "custom",
        origin_post_id: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    });
    // over_cap must not leak onto the returned template shape.
    expect("over_cap" in (result as { value: object }).value).toBe(false);

    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("claim_content_template_slot", {
      p_workspace_id: "ws1",
      p_max_templates: TEMPLATES_PER_WORKSPACE_MAX,
      p_title: "My template",
      p_category: "story",
      p_body: "Body {placeholder}",
      p_source: "custom",
      p_origin_post_id: null,
    });
  });

  // REGRESSION: at the cap, the RPC reports over_cap — no second read is
  // needed (and no window exists in which a racing caller could slip past,
  // since the count+insert decision was made atomically inside the DB lock).
  test("REGRESSION: at the cap, a single RPC call reports over_cap — no insert, no separate count round trip", async () => {
    const db = fakeDb({
      data: {
        id: null, workspace_id: null, title: null, category: null, body: null,
        source: null, origin_post_id: null, created_at: null, updated_at: null,
        over_cap: true,
      },
      error: null,
    });
    const result = await createTemplateResource({
      db,
      workspaceId: "ws1",
      data: { title: "One too many", category: null, body: "Body" },
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: `You've reached the limit of ${TEMPLATES_PER_WORKSPACE_MAX} templates. Delete one to add another.`,
    });
    // Exactly one network round trip total — the cap check and the (skipped)
    // insert both happened inside the single atomic RPC call.
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  test("an RPC-level error is thrown, not swallowed", async () => {
    const db = fakeDb({ data: null, error: { message: "db unavailable" } });
    await expect(
      createTemplateResource({
        db,
        workspaceId: "ws1",
        data: { title: "T", category: null, body: "B" },
      }),
    ).rejects.toMatchObject({ message: "db unavailable" });
  });
});
