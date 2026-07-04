import { describe, test, expect } from "vitest";
import {
  NO_MODEL_FORMATS,
  selectNoModelFormat,
  renderNoModelFormatBlock,
  isNoModelPostRequest,
  type NoModelExample,
} from "@/lib/agent/no-model-formats";

// ---------------------------------------------------------------------------
// The no-model format router. When the user asks for a NEW post from scratch
// (no "Model this post" / template / refine source), the app silently picks a
// LinkedIn-native archetype, fetches real exemplar posts, and injects the
// format rules + examples so the writing agent has a concrete structural
// reference. These tests cover: (1) the deterministic router picks a sensible
// format, (2) the prompt block is well-formed and safe (study structure only,
// don't invent facts), and (3) the activation gate does NOT fire for
// modeled/template/refine turns or hooks/analysis/board commands.
// ---------------------------------------------------------------------------

const id = (msg: string) => selectNoModelFormat(msg).id;

describe("selectNoModelFormat — router picks a sensible archetype", () => {
  test("a lead-magnet SYSTEM/workflow prompt → system breakdown", () => {
    expect(id("write a lead magnet post for my free automation workflow")).toBe(
      "lead_magnet_system_breakdown",
    );
    expect(id("draft a giveaway post about my n8n playbook, comment to get it")).toBe(
      "lead_magnet_system_breakdown",
    );
  });

  test("a generic lead-magnet / free-resource prompt → resource inventory", () => {
    expect(id("write a lead magnet post for my free ICP worksheet")).toBe(
      "lead_magnet_resource_inventory",
    );
    expect(id("make a post giving away my free resource, comment for it")).toBe(
      "lead_magnet_resource_inventory",
    );
  });

  test("a resource-bundle prompt → resource inventory", () => {
    expect(id("write a post about my template pack bundle")).toBe(
      "lead_magnet_resource_inventory",
    );
  });

  test("a tips / steps prompt → tactical listicle", () => {
    expect(id("draft a post with tips for cold email")).toBe("tactical_listicle");
    expect(id("write a post with 5 steps to warm up a domain")).toBe(
      "tactical_listicle",
    );
  });

  test("a mistake-focused prompt → mistake breakdown (not a bare listicle)", () => {
    expect(id("write a post about 5 mistakes founders make with LinkedIn")).toBe(
      "mistake_breakdown",
    );
    expect(id("draft a post about why most cold emails fail")).toBe(
      "mistake_breakdown",
    );
    expect(id("post about the wrong way people use AI for writing")).toBe(
      "mistake_breakdown",
    );
  });

  test("a personal mistake stays a story, not a mistake breakdown", () => {
    // "when I" / "I learned" is a personal narrative — the story shape wins.
    expect(id("write a post about the mistake I made when I raised my prices")).toBe(
      "personal_authority_story",
    );
  });

  test("a contrarian / belief-challenge prompt → contrarian take", () => {
    expect(id("write a contrarian post about posting daily on LinkedIn")).toBe(
      "contrarian_take",
    );
    expect(id("write a post: most people think cold email is dead")).toBe(
      "contrarian_take",
    );
    expect(id("draft an unpopular opinion post about AI writing")).toBe(
      "contrarian_take",
    );
  });

  test("a before/after transformation prompt → before/after", () => {
    expect(id("write a before and after post about our onboarding")).toBe(
      "before_after_transformation",
    );
    expect(id("draft a post about how I went from 0 to 10k followers")).toBe(
      "before_after_transformation",
    );
    expect(id("write a post about our agency turnaround")).toBe(
      "before_after_transformation",
    );
  });

  test("an explain / framework prompt → explainer breakdown", () => {
    expect(id("explain MCP to founders")).toBe("explainer_framework_breakdown");
    expect(id("write a post that breaks down our onboarding framework")).toBe(
      "explainer_framework_breakdown",
    );
  });

  test("a personal story prompt → personal authority story", () => {
    expect(id("write a post about the time I almost lost my biggest client")).toBe(
      "personal_authority_story",
    );
    expect(id("draft a post about a lesson I learned this year")).toBe(
      "personal_authority_story",
    );
  });

  test("an event / launch prompt → event announcement", () => {
    expect(id("write a post announcing our webinar next week")).toBe(
      "event_announcement",
    );
  });

  test("a proof / case-study prompt → offer proof giveaway", () => {
    expect(id("write a post about my client result — we booked 30 calls")).toBe(
      "offer_proof_giveaway",
    );
  });

  test("a bare from-scratch post with no strong signal falls back to explainer", () => {
    expect(id("write a linkedin post about AI writing")).toBe(
      "explainer_framework_breakdown",
    );
  });

  test("is deterministic across repeated calls", () => {
    const msg = "write a post about 5 mistakes founders make";
    expect(id(msg)).toBe(id(msg));
  });
});

describe("NO_MODEL_FORMATS — library integrity", () => {
  test("every format has a non-empty structure, when-to-use, and exemplar id", () => {
    for (const f of NO_MODEL_FORMATS) {
      expect(f.structure.length).toBeGreaterThan(0);
      expect(f.whenToUse.length).toBeGreaterThan(0);
      expect(f.exemplarPostIds.length).toBeGreaterThan(0);
    }
  });

  test("format ids are unique", () => {
    const ids = NO_MODEL_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all exemplar ids are well-formed UUIDs", () => {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const f of NO_MODEL_FORMATS) {
      for (const pid of f.exemplarPostIds) {
        expect(pid).toMatch(uuid);
      }
    }
  });
});

const EXAMPLES: NoModelExample[] = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    author: "Jane Doe",
    niche: "SaaS",
    text: "Everyone chases more leads.\n\nWe fixed retention instead.\n\nHere is what changed.",
    engagement: { reactions: 1200, comments: 88, reposts: 14, viral_score: 9 },
  },
];

describe("renderNoModelFormatBlock — prompt block is well-formed + safe", () => {
  const format = NO_MODEL_FORMATS.find((f) => f.id === "tactical_listicle")!;

  test("includes the selected format label and its structure", () => {
    const block = renderNoModelFormatBlock(format, EXAMPLES);
    expect(block).toContain(format.label);
    // A structure step should appear.
    expect(block).toContain(format.structure[0]);
  });

  test("wraps each exemplar in START/END delimiters with the full text", () => {
    const block = renderNoModelFormatBlock(format, EXAMPLES);
    expect(block).toContain("--- EXAMPLE POST START ---");
    expect(block).toContain("--- EXAMPLE POST END ---");
    expect(block).toContain("We fixed retention instead.");
  });

  test("tells the model to study STRUCTURE ONLY and not copy facts/text", () => {
    const block = renderNoModelFormatBlock(format, EXAMPLES);
    expect(block).toMatch(/STRUCTURE ONLY/);
    expect(block).toMatch(/Do not copy wording, facts, claims, CTAs, names/i);
  });

  test("tells the model not to invent facts — ask or bracket the unknowns", () => {
    const block = renderNoModelFormatBlock(format, EXAMPLES);
    expect(block).toMatch(/do not invent/i);
    expect(block).toMatch(/ask_user|ask ONE/i);
    expect(block).toContain("[YOUR RESULT]");
  });

  test("keeps the selection SILENT and defers to the voice profile", () => {
    const block = renderNoModelFormatBlock(format, EXAMPLES);
    expect(block).toMatch(/silently|Do NOT tell the user/i);
    expect(block).toMatch(/voice profile.*outranks|voice first/i);
  });

  test("says NO source post was provided (don't use a modeling shape)", () => {
    const block = renderNoModelFormatBlock(format, EXAMPLES);
    expect(block).toMatch(/no source post/i);
  });

  test("with NO exemplars, still emits the format rules but omits the examples header", () => {
    const block = renderNoModelFormatBlock(format, []);
    expect(block).toContain(format.label);
    expect(block).toContain(format.structure[0]);
    // The "study these examples" framing must not appear with nothing under it.
    expect(block).not.toContain("--- EXAMPLE POST START ---");
    expect(block).not.toMatch(/examples to study for STRUCTURE ONLY/i);
  });
});

describe("isNoModelPostRequest — activation gate", () => {
  test("fires for a plain from-scratch post request with no source", () => {
    expect(isNoModelPostRequest("write a post about AI writing tells", false)).toBe(
      true,
    );
    expect(isNoModelPostRequest("draft a linkedin post about churn", false)).toBe(
      true,
    );
    expect(
      isNoModelPostRequest("make a post about my lead magnet", false),
    ).toBe(true);
  });

  test("does NOT fire when a model/template/refine source is present", () => {
    expect(isNoModelPostRequest("write a post about churn", true)).toBe(false);
  });

  test("does NOT fire when the message carries a model/template/refine envelope", () => {
    expect(
      isNoModelPostRequest(
        "write a post like this\n\n--- POST TO MODEL AFTER ---\nfoo\n--- END POST ---",
        false,
      ),
    ).toBe(false);
    expect(
      isNoModelPostRequest(
        "fill this\n\n--- TEMPLATE TO FILL ---\n{x}\n--- END TEMPLATE ---",
        false,
      ),
    ).toBe(false);
    expect(
      isNoModelPostRequest(
        "make it shorter\n\n--- POST TO REFINE ---\nfoo\n--- END POST ---",
        false,
      ),
    ).toBe(false);
  });

  test("does NOT fire for a hooks request (partial deliverable, not a post)", () => {
    expect(isNoModelPostRequest("give me 5 hooks about cold email", false)).toBe(
      false,
    );
    expect(isNoModelPostRequest("write me some openers for a churn post", false)).toBe(
      false,
    );
  });

  test("does NOT fire for analysis / search / board commands", () => {
    expect(isNoModelPostRequest("analyze this post for me", false)).toBe(false);
    expect(isNoModelPostRequest("find posts about hiring", false)).toBe(false);
    expect(isNoModelPostRequest("schedule the hiring post for Tuesday", false)).toBe(
      false,
    );
    expect(isNoModelPostRequest("mark the SaaS one ready", false)).toBe(false);
  });

  test("does NOT fire for a plain question / non-post message", () => {
    expect(isNoModelPostRequest("what's in my queue?", false)).toBe(false);
    expect(isNoModelPostRequest("hello there", false)).toBe(false);
  });
});
