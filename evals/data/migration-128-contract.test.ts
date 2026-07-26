import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  "db/migration-128-preference-evidence.sql",
  "utf8",
);

describe("migration 128 contract", () => {
  test("links learned preferences to exact revision evidence", () => {
    expect(sql).toContain("content_preference_evidence");
    expect(sql).toContain("preference_id uuid not null");
    expect(sql).toContain("revision_event_id uuid not null");
    expect(sql).toContain("batch_id uuid not null");
    expect(sql).toContain("rule_snapshot text not null");
    expect(sql).toContain("unique (preference_id, revision_event_id)");
    expect(sql).toContain("validate_content_preference_evidence_scope");
    expect(sql).toContain("reject_content_preference_evidence_update");
    expect(sql).toContain("preference.source = 'edit_delta'");
  });

  test("keeps evidence writes server-only and idempotent", () => {
    expect(sql).toContain("persist_content_preference_candidate");
    expect(sql).toContain("content_preference_learning_outcomes");
    expect(sql).toContain(
      "lock table public.content_preferences in share row exclusive mode",
    );
    expect(sql).not.toContain("[:punct:]");
    expect(sql).toContain("on delete set null");
    expect(sql).toContain("saved_candidate->'evidenceEventIds'");
    expect(sql).toContain("processing_state.batch_id = p_batch_id");
    expect(sql).toContain("voice_edit_distiller_v2");
    expect(sql).toContain("with legacy_batches as");
    expect(sql).toContain("list_content_preference_evidence");
    expect(sql).toContain("left(event.before_body, 1500)");
    expect(sql).toContain("cardinality(p_preference_ids) not between 1 and 20");
    expect(sql).toContain("partition by evidence.preference_id");
    expect(sql).toContain(
      "content_preference_evidence_preference_id_revision_event_id_key",
    );
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).not.toContain("for insert");
  });
});
