import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL(
    "../../db/migration-126-backfill-artifact-lineage.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 126 historical lineage backfill", () => {
  test("backfills every uncovered Artifact idempotently without invented provenance", () => {
    expect(sql).toMatch(/insert into public\.artifact_lineage/i);
    expect(sql).toMatch(/from public\.chat_artifacts artifact/i);
    expect(sql).toMatch(/not exists[\s\S]*lineage\.artifact_id = artifact\.id/i);
    expect(sql).toMatch(/on conflict \(artifact_id\) do nothing/i);
    expect(sql).toContain(
      "Historical direction unavailable; Draft predates lineage capture.",
    );
    expect(sql).toMatch(/'unknown'/i);
    expect(sql).not.toMatch(
      /'Historical direction unavailable; Draft predates lineage capture\.'[\s\S]{0,400}'create'/i,
    );
    expect(sql).toMatch(/'kind', 'backfill'/i);
  });

  test("replays trusted generation seeds before the unknown backfill", () => {
    expect(sql).toMatch(
      /source_artifact\.value->>'id' = submitted_seed->>'sourceArtifactId'/i,
    );
    expect(sql).toMatch(
      /source_artifact\.value->'meta'->'content_lineage'->>'userMessageId'[\s\S]*user_message\.id::text/i,
    );
    expect(sql).toMatch(
      /select source_artifact\.value->'meta'->'content_lineage' as seed/i,
    );
    expect(sql).not.toMatch(
      /where not \(coalesce\(artifact\.meta, '\{\}'::jsonb\) \? 'content_lineage'\)/i,
    );
  });

  test("advances the schema version", () => {
    expect(sql).toMatch(
      /values\s*\(\s*true\s*,\s*126\s*,\s*now\(\)\s*\)/i,
    );
  });
});
