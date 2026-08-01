import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
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
const synthesisSource = readFileSync(
  new URL("../../lib/agent-inbox/synthesis.ts", import.meta.url),
  "utf8",
);

function ev(kind: AgentInboxEvidence["kind"]): AgentInboxEvidence {
  return { kind, label: `${kind} label`, detail: "detail" };
}

describe("framework lanes", () => {
  test("the lanes are the four post frameworks", () => {
    // The old now/proven/explore axis described where evidence came from, so
    // two cards could share a framework and read as near-duplicates while
    // sitting in different lanes. Naming the framework fixes that by
    // construction.
    expect([...AGENT_INBOX_LANES]).toEqual([
      "newsjacking",
      "personal_story",
      "namejacking",
      "educational",
    ]);
  });
});

describe("laneEvidenceSatisfied", () => {
  test("newsjacking and namejacking both require a dated story", () => {
    // Timeliness is the claim newsjacking makes; namejacking needs a named
    // person or company, which only ever arrives on a news item.
    for (const lane of ["newsjacking", "namejacking"] as const) {
      expect(laneEvidenceSatisfied(lane, [ev("news")])).toBe(true);
      expect(laneEvidenceSatisfied(lane, [ev("knowledge")])).toBe(false);
      expect(laneEvidenceSatisfied(lane, [ev("performance")])).toBe(false);
      expect(laneEvidenceSatisfied(lane, [])).toBe(false);
    }
  });

  test("personal_story requires the user's own material", () => {
    // A "your story" card built from a news article is a news card wearing the
    // wrong label, and shipping one teaches the user the lanes mean nothing.
    expect(laneEvidenceSatisfied("personal_story", [ev("knowledge")])).toBe(
      true,
    );
    expect(laneEvidenceSatisfied("personal_story", [ev("voice")])).toBe(true);
    expect(laneEvidenceSatisfied("personal_story", [ev("news")])).toBe(false);
    expect(laneEvidenceSatisfied("personal_story", [ev("performance")])).toBe(
      false,
    );
  });

  test("educational requires demonstrated expertise, not a news hook", () => {
    expect(laneEvidenceSatisfied("educational", [ev("performance")])).toBe(
      true,
    );
    expect(laneEvidenceSatisfied("educational", [ev("knowledge")])).toBe(true);
    expect(laneEvidenceSatisfied("educational", [ev("source_post")])).toBe(
      true,
    );
    // Anything else would be a generic explainer with a headline.
    expect(laneEvidenceSatisfied("educational", [ev("news")])).toBe(false);
  });

  test("every lane rejects an empty evidence list", () => {
    // An unmet lane stays empty. Same trade as the pre-existing newsjacking
    // rule: an empty lane is honest, a mislabelled card is not.
    for (const lane of AGENT_INBOX_LANES) {
      expect(laneEvidenceSatisfied(lane, [])).toBe(false);
    }
  });

  test("a mixed bundle satisfies whichever lane its kinds support", () => {
    const mixed = [ev("news"), ev("knowledge")];
    expect(laneEvidenceSatisfied("newsjacking", mixed)).toBe(true);
    expect(laneEvidenceSatisfied("personal_story", mixed)).toBe(true);
    expect(laneEvidenceSatisfied("educational", mixed)).toBe(true);
  });
});

describe("synthesis prompt", () => {
  test("names each lane as a distinct kind of post", () => {
    expect(synthesisSource).toContain("Each lane is a DIFFERENT KIND of post");
    for (const lane of [
      "NEWSJACKING",
      "PERSONAL_STORY",
      "NAMEJACKING",
      "EDUCATIONAL",
    ]) {
      expect(synthesisSource).toContain(lane);
    }
  });

  test("forbids inventing a personal story", () => {
    // The one lane where a fabrication would be a lie about the user's life.
    expect(synthesisSource).toContain("Never invent one");
  });

  test("requires namejacking to name someone and not disparage them", () => {
    expect(synthesisSource).toContain("SPECIFIC named person or company");
    expect(synthesisSource).toContain("Never disparage a named person");
  });
});

describe("draft hand-off", () => {
  test("each lane frames the draft as its own kind of post", () => {
    // Verified against selectSkills(): the newsjacking and namejacking prompts
    // activate their authored skills by naming them, so acting on a card
    // starts the draft with that framework's craft rules already applied.
    // personal_story and educational have no dedicated skill and carry an
    // explicit instruction instead.
    const framings = AGENT_INBOX_LANES.map((lane) =>
      agentInboxDraftPrompt({ ...baseIdea, lane }),
    );
    expect(framings[0]).toContain("/newsjacking");
    expect(framings[1]).toContain("never invent a story");
    expect(framings[2]).toContain("/namejacking");
    expect(framings[3]).toContain("educational post");
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

describe("agent names", () => {
  const source = readFileSync(
    new URL("../../app/(app)/dashboard/agent-inbox.tsx", import.meta.url),
    "utf8",
  );

  test("every lane has a distinct agent name", () => {
    // "Expertise" rather than "Educational" because the lane is gated on
    // demonstrated results rather than on a teaching format.
    for (const name of [
      "Trend Radar Agent",
      "Story Miner Agent",
      "Namedrop Agent",
      "Expertise Agent",
    ]) {
      expect(source).toContain(`label: "${name}"`);
    }
    // Guards a rename that collapses two lanes onto one label.
    expect(source.match(/label: "[^"]*Agent"/g)).toHaveLength(
      AGENT_INBOX_LANES.length,
    );
  });
});
