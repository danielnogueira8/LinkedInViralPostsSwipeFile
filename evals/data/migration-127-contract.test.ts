import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  "db/migration-127-revision-event-cursor.sql",
  "utf8",
);

describe("migration 127 contract", () => {
  test("enriches revision evidence with lineage, hashes, origin, and metrics", () => {
    expect(sql).toContain("lineage_id uuid");
    expect(sql).toContain("edit_origin text");
    expect(sql).toContain("before_hash text");
    expect(sql).toContain("after_hash text");
    expect(sql).toContain("change_summary jsonb");
    expect(sql).toContain("prepare_draft_edit_event");
    expect(sql).toContain("validate_draft_edit_event_lineage");
    expect(sql).toContain("reconcile_draft_edit_events_after_lineage");
    expect(sql).toContain("artifact_lineage_reconcile_draft_edit_events");
    expect(sql).toContain("extensions.digest(");
    expect(sql).not.toContain("public.digest(");
  });

  test("uses leased per-event processing state and server-only operations", () => {
    expect(sql).toContain("content_learning_processing_cursors");
    expect(sql).toContain("event_id uuid not null");
    expect(sql).toContain("distillation_result jsonb");
    expect(sql).toContain("claim_draft_edit_event_batch");
    expect(sql).toContain("persist_draft_edit_event_batch_result");
    expect(sql).toContain("complete_draft_edit_event_batch");
    expect(sql).toContain("release_draft_edit_event_batch");
    expect(sql).toContain("processing_state.completed_at is null");
    expect(sql).not.toContain("(event.created_at, event.id) >");
    expect(sql).toContain("revoke all on function");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });

  test("removes the old all-commands browser policy", () => {
    expect(sql).toContain("drop policy if exists draft_edit_events_isolation");
    expect(sql).toContain("create policy draft_edit_events_select");
    expect(sql).toContain("drop policy if exists draft_edit_events_insert");
    expect(sql).not.toContain("create policy draft_edit_events_insert");
    expect(sql).not.toContain("create policy draft_edit_events_isolation");
  });
});
