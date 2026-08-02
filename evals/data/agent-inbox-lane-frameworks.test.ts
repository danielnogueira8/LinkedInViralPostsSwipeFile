import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  AGENT_FEED_LANES,
  AGENT_INBOX_LANES,
  laneEvidenceSatisfied,
  type AgentInboxEvidence,
  type AgentInboxIdea,
} from "@/lib/agent-inbox";
import { agentInboxDraftPrompt } from "@/lib/agent-inbox/prompt";

const baseIdea: AgentInboxIdea = {
  id: "idea-1",
  workspaceId: "workspace-1",
  lane: "newsjacking",
  status: "active",
  headline: "A direction",
  angle: "An angle",
  why: ["A reason"],
  evidence: [],
  sourceKind: "news",
  sourceRef: null,
  sourceUrl: null,
  sourceTitle: null,
  sourcePublishedAt: null,
  score: 0.9,
  fingerprint: "fp-1",
  availableOn: "2026-07-30",
  expiresAt: null,
  snoozedUntil: null,
  actedAt: null,
  discardReason: null,
  readAt: null,
  createdAt: "2026-07-30T08:00:00Z",
  updatedAt: "2026-07-30T08:00:00Z",
};

const migration = readFileSync(
  new URL(
    "../../db/migration-161-agent-inbox-framework-lanes.sql",
    import.meta.url,
  ),
  "utf8",
);
const retirementMigration = readFileSync(
  new URL(
    "../../db/migration-166-retire-namejacking-inbox-lane.sql",
    import.meta.url,
  ),
  "utf8",
);
const synthesisSource = readFileSync(
  new URL("../../lib/agent-inbox/synthesis.ts", import.meta.url),
  "utf8",
);

function ev(kind: AgentInboxEvidence["kind"]): AgentInboxEvidence {
  return {
    kind,
    role:
      kind === "source_post"
        ? "inspiration"
        : kind === "draft"
          ? "context"
          : "anchor",
    label: kind === "news" ? "LinkedIn announces a new feature" : `${kind} label`,
    detail: "detail",
    ...(kind === "news"
      ? {
          url: "https://example.com/news",
          publishedAt: "2026-07-30T07:00:00.000Z",
        }
      : {}),
    ...(kind === "source_post"
      ? {
          ref: "source-post-1",
          url: "https://example.com/source-post-1",
        }
      : {}),
    ...(kind === "performance"
      ? { confidence: 0.8, sampleSize: 12 }
      : {}),
    ...(kind === "knowledge" ? { subtype: "proof" } : {}),
  };
}

describe("framework lanes", () => {
  test("the feed puts Trend Radar first and keeps only the current inbox lanes", () => {
    // The old now/proven/explore axis described where evidence came from, so
    // two cards could share a framework and read as near-duplicates while
    // sitting in different lanes. Naming the framework fixes that by
    // construction.
    expect([...AGENT_INBOX_LANES]).toEqual([
      "personal_story",
      "educational",
    ]);
    expect([...AGENT_FEED_LANES]).toEqual([
      "trend_radar",
      "personal_story",
      "educational",
    ]);
  });
});

describe("laneEvidenceSatisfied", () => {
  test("newsjacking requires a dated story", () => {
    expect(laneEvidenceSatisfied("newsjacking", [ev("news")])).toBe(true);
    expect(laneEvidenceSatisfied("newsjacking", [ev("knowledge")])).toBe(false);
    expect(laneEvidenceSatisfied("newsjacking", [ev("performance")])).toBe(false);
    expect(laneEvidenceSatisfied("newsjacking", [])).toBe(false);
  });

  test("personal_story requires the user's own material", () => {
    // A "your story" card built from a news article is a news card wearing the
    // wrong label, and shipping one teaches the user the lanes mean nothing.
    expect(
      laneEvidenceSatisfied("personal_story", [
        ev("source_post"),
        { ...ev("knowledge"), subtype: "story" },
      ]),
    ).toBe(true);
    expect(laneEvidenceSatisfied("personal_story", [ev("knowledge")])).toBe(
      false,
    );
    expect(laneEvidenceSatisfied("personal_story", [ev("source_post")])).toBe(
      false,
    );
    expect(laneEvidenceSatisfied("personal_story", [ev("news")])).toBe(false);
    expect(laneEvidenceSatisfied("personal_story", [ev("performance")])).toBe(
      false,
    );
  });

  test("educational requires demonstrated expertise, not a news hook", () => {
    expect(
      laneEvidenceSatisfied("educational", [
        ev("source_post"),
        ev("performance"),
      ]),
    ).toBe(true);
    expect(
      laneEvidenceSatisfied("educational", [
        ev("source_post"),
        { ...ev("knowledge"), subtype: "topic_expertise" },
      ]),
    ).toBe(true);
    expect(laneEvidenceSatisfied("educational", [ev("performance")])).toBe(
      false,
    );
    expect(laneEvidenceSatisfied("educational", [ev("source_post")])).toBe(
      false,
    );
    // Anything else would be a generic explainer with a headline.
    expect(laneEvidenceSatisfied("educational", [ev("news")])).toBe(false);
    expect(
      laneEvidenceSatisfied("educational", [
        ev("source_post"),
        {
          ...ev("performance"),
          confidence: 0.2,
          sampleSize: 1,
        },
      ]),
    ).toBe(false);
  });

  test("every lane rejects an empty evidence list", () => {
    // An unmet lane stays empty. Same trade as the pre-existing newsjacking
    // rule: an empty lane is honest, a mislabelled card is not.
    for (const lane of AGENT_INBOX_LANES) {
      expect(laneEvidenceSatisfied(lane, [])).toBe(false);
    }
  });

  test("a mixed bundle satisfies whichever lane its kinds support", () => {
    const mixed = [
      ev("news"),
      ev("source_post"),
      ev("knowledge"),
    ];
    expect(laneEvidenceSatisfied("newsjacking", mixed)).toBe(true);
    expect(laneEvidenceSatisfied("personal_story", mixed)).toBe(true);
    expect(laneEvidenceSatisfied("educational", mixed)).toBe(true);
  });
});

describe("synthesis prompt", () => {
  test("names each lane as a distinct kind of post", () => {
    expect(synthesisSource).toContain("Each lane is a DIFFERENT KIND of post");
    for (const lane of ["PERSONAL_STORY", "EDUCATIONAL"]) {
      expect(synthesisSource).toContain(lane);
    }
  });

  test("forbids inventing a personal story", () => {
    // The one lane where a fabrication would be a lie about the user's life.
    expect(synthesisSource).toContain("Never invent one");
  });

});

describe("draft hand-off", () => {
  test("each lane frames the draft as its own kind of post", () => {
    // Newsjacking is no longer a daily inbox lane. The remaining lanes carry
    // explicit instructions into Cowork instead.
    const framings = AGENT_INBOX_LANES.map((lane) =>
      agentInboxDraftPrompt({ ...baseIdea, lane }),
    );
    expect(framings[0]).toContain("never invent a story");
    expect(framings[1]).toContain("educational post");
    // Every lane says something different about how to write.
    expect(new Set(framings).size).toBe(AGENT_INBOX_LANES.length);
  });
});

describe("migration 161", () => {
  test("remaps existing rows instead of dropping them", () => {
    // A user mid-cycle keeps their board: a timely card becomes newsjacking,
    // and both evidence-grounded lanes become educational.
    expect(migration).toContain("when lane = 'now' then 'newsjacking'");
    expect(migration).toContain("when lane = 'proven' then 'educational'");
    expect(migration).toContain("when lane = 'explore' then 'educational'");
  });

  test("remaps historical run rows too", () => {
    // claim_agent_inbox_run validates requested_lanes against the allowed
    // set, so leaving old values in history would make it reject its own past.
    expect(migration).toContain("update public.agent_inbox_runs");
    expect(migration).toContain("requested_lanes");
  });

  test("replaces the lane check constraint with the framework set", () => {
    expect(migration).toContain(
      "check (lane in ('newsjacking', 'personal_story', 'namejacking', 'educational'))",
    );
  });

  test("keeps the stale-run reclaim from migration 160", () => {
    // The claim function is recreated here, so the 15-minute reclaim and the
    // attempts-guard ordering must survive rather than silently regress.
    expect(migration).toContain("stale_after constant interval");
    expect(migration).toContain("existing.started_at > now() - stale_after");
    const guard = migration.indexOf("if existing.attempts >= 5");
    const update = migration.indexOf("attempts = run.attempts + 1");
    expect(guard).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(guard);
  });

  test("advances the schema version", () => {
    expect(migration).toContain("values (true, 161, now())");
  });
});

describe("migration 166", () => {
  test("preserves Namedrop history by remapping it to Newsjacking", () => {
    expect(retirementMigration).toContain(
      "set lane = 'newsjacking'",
    );
    expect(retirementMigration).toContain("where lane = 'namejacking'");
    expect(retirementMigration).toContain(
      "when lane = 'namejacking' then 'newsjacking'",
    );
  });

  test("removes the retired lane from the database allow-lists", () => {
    expect(retirementMigration).toContain(
      "check (lane in ('newsjacking', 'personal_story', 'educational'))",
    );
    expect(retirementMigration).toContain(
      "where lane not in ('newsjacking', 'personal_story', 'educational')",
    );
  });

  test("advances the schema version", () => {
    expect(retirementMigration).toContain("values (true, 166, now())");
  });
});

describe("agent names", () => {
  const source = readFileSync(
    new URL("../../app/(app)/dashboard/agent-inbox.tsx", import.meta.url),
    "utf8",
  );

  test("every lane has a distinct agent name", () => {
    // The UI labels are short outcomes, not repeated "Agent" suffixes. They
    // stay distinct so the filter bar remains scannable.
    const laneLabels = ["Trend Radar", "Story Miner", "Expertise"];
    for (const name of laneLabels) {
      expect(source).toContain(`label: "${name}"`);
    }
    expect(new Set(laneLabels).size).toBe(AGENT_FEED_LANES.length);
  });
});
