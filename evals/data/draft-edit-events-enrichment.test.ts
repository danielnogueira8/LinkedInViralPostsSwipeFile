import { describe, expect, test } from "vitest";
import {
  recordDraftEditEvent,
  summarizeDraftRevision,
} from "@/lib/draft-edit-events";

function fakeDb() {
  const inserts: Array<Record<string, unknown>> = [];
  const db = {
    from() {
      return {
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: null };
        },
      };
    },
  };
  return { db: db as never, inserts };
}

describe("Draft revision-event enrichment", () => {
  test("computes deterministic character and line deltas", () => {
    expect(summarizeDraftRevision("One\nTwo", "One\nTwo\nThree")).toEqual({
      beforeChars: 7,
      afterChars: 13,
      deltaChars: 6,
      beforeLines: 2,
      afterLines: 3,
      deltaLines: 1,
    });
  });

  test("preserves exact whitespace and source Artifact identity", async () => {
    const { db, inserts } = fakeDb();

    await recordDraftEditEvent({
      sb: db,
      workspaceId: "ws-1",
      artifactId: "20000000-0000-4000-8000-000000000001",
      beforeBody: "Before\n",
      afterBody: "Before\n\n",
      editOrigin: "posts_editor",
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      schema_version: 1,
      workspace_id: "ws-1",
      source_artifact_id: "20000000-0000-4000-8000-000000000001",
      saved_artifact_id: null,
      lineage_id: null,
      before_body: "Before\n",
      after_body: "Before\n\n",
      edit_origin: "posts_editor",
      change_summary: {
        beforeChars: 7,
        afterChars: 8,
        deltaChars: 1,
        beforeLines: 2,
        afterLines: 3,
        deltaLines: 1,
      },
    });
    expect(inserts[0].before_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inserts[0].after_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inserts[0].before_hash).not.toBe(inserts[0].after_hash);
  });

  test("accepts normal unsaved Cowork Artifact IDs", async () => {
    const { db, inserts } = fakeDb();

    await recordDraftEditEvent({
      sb: db,
      workspaceId: "ws-1",
      artifactId: "art_1753000000000_0",
      beforeBody: "Before",
      afterBody: "After",
      editOrigin: "cowork_artifact",
    });

    expect(inserts[0]).toMatchObject({
      source_artifact_id: "art_1753000000000_0",
      saved_artifact_id: null,
      lineage_id: null,
      edit_origin: "cowork_artifact",
    });
  });

  test("preserves a valid edit whose new body is whitespace-only", async () => {
    const { db, inserts } = fakeDb();

    await recordDraftEditEvent({
      sb: db,
      workspaceId: "ws-1",
      artifactId: "art_1753000000000_0",
      beforeBody: "Before",
      afterBody: " \n ",
      editOrigin: "cowork_artifact",
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      before_body: "Before",
      after_body: " \n ",
      change_summary: {
        beforeChars: 6,
        afterChars: 3,
      },
    });
  });
});
