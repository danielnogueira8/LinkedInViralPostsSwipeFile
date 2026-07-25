import { describe, expect, test } from "vitest";
import { SKILLS, selectSkills } from "@/lib/agent/skills";

// ---------------------------------------------------------------------------
// The lead-magnet skill was a generic 5-step outline. It now carries the 18
// hook frameworks, a truth constraint, and a QA gate.
//
// The truth constraint is the load-bearing part: these posts promise a resource
// and cite numbers, so a skill that lets the model invent a client win or a
// deliverable it cannot produce turns into a public, false claim by the USER.
// ---------------------------------------------------------------------------

const body = SKILLS.find((s) => s.id === "lead-magnet")?.body ?? "";

describe("truth constraint", () => {
  test("forbids inventing proof outright", () => {
    expect(body).toMatch(/NEVER invent/);
    expect(body).toMatch(/client wins|dollar figures|testimonials/i);
  });

  test("names proof-free frameworks, so 'no proof' has a real fallback", () => {
    // Without this the model's only options are fabricate or refuse.
    expect(body).toMatch(/proof-free/i);
    expect(body).toMatch(/weaker honest hook beats a fabricated/i);
  });

  test("separates what can actually be produced from what cannot", () => {
    // Promising a hosted GPT or a video course in a post the user then publishes
    // is a commitment they cannot keep.
    expect(body).toMatch(/Cannot be produced here/);
    for (const impossible of ["working software", "video courses", "hosted GPTs"]) {
      expect(body.toLowerCase()).toContain(impossible.toLowerCase());
    }
  });

  test("BREAKING requires verifying the event, never recalling it", () => {
    expect(body).toMatch(/Verify it with a tool; never from memory/);
  });
});

describe("frameworks and structure survived", () => {
  test("carries all 18 numbered frameworks", () => {
    for (let i = 1; i <= 18; i += 1) {
      expect(body, `framework ${i}`).toMatch(new RegExp(`(^|\\n)${i}\\. `, "m"));
    }
  });

  test("keeps the CTA ladder and the P.S. rule", () => {
    expect(body).toMatch(/comment KEYWORD/i);
    expect(body).toMatch(/ALL CAPS/);
    expect(body).toMatch(/P\.S\./);
  });

  test("keeps the deliverable bounds", () => {
    expect(body).toMatch(/5-7 arrow/);
    expect(body).toMatch(/OUTCOME or asset, never a feature/);
  });
});

describe("it only references tools this agent actually has", () => {
  test("uses search_viral_posts, which exists", () => {
    expect(body).toMatch(/search_viral_posts/);
  });

  test("does NOT instruct the agent to call tools it does not have", () => {
    // create_draft / create_lead_magnet live on the external MCP server, not in
    // the Cowork agent loop — instructing the model to call them would produce
    // a hallucinated tool call every time.
    expect(body).not.toMatch(/create_draft|create_lead_magnet/);
  });
});

describe("selection", () => {
  test("still triggers on the usual phrasings", () => {
    for (const msg of ["write a lead magnet post", "make me a giveaway", "freebie post"]) {
      expect(selectSkills(msg).map((s) => s.id), msg).toContain("lead-magnet");
    }
  });

  test("stays specialized so the selection cap can't drop it", () => {
    expect(SKILLS.find((s) => s.id === "lead-magnet")?.specialized).toBe(true);
  });
});
