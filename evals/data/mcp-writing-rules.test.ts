import { describe, expect, test, vi } from "vitest";
import {
  buildWritingRules,
  publicFormatCatalog,
  DEFAULT_WRITING_RULE_SECTIONS,
  WRITING_RULE_SECTIONS,
} from "@/lib/writing-rules";
import {
  ANTI_AI_READER_TELL_RULES,
  GLOBAL_WRITING_SKILL,
  OUTPUT_LANGUAGE_RULE,
  POST_STRUCTURE_SKILL,
} from "@/lib/agent/skills";
import { NO_MODEL_FORMATS } from "@/lib/agent/no-model-formats";

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ from: () => ({}) }) }));
vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIdsForService: async () => [],
  trackedAccountIds: async () => [],
  latestRelevantScrapeForService: async () => null,
}));
vi.mock("@/lib/ai-operation-claims", () => ({
  claimAiOperation: async () => "claim-1",
  releaseAiOperation: async () => undefined,
}));
vi.mock("@/lib/agent/rate-limit", () => ({
  VOICE_JOB_COST_RESERVE_USD: 0.2,
  checkChatCostAllowance: async () => ({ ok: true }),
  checkChatRateLimit: async () => ({ ok: true }),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: async () => ({ id: "job-1" }),
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

function registry() {
  const handlers: Record<string, ToolHandler> = {};
  const configs: Record<string, { description?: string }> = {};
  registerSwipeTools({
    registerTool: (name: string, config: { description?: string }, handler: ToolHandler) => {
      handlers[name] = handler;
      configs[name] = config;
    },
  } as never);
  return { handlers, configs };
}

function json(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("writing rules — no drift from the pipeline", () => {
  // THE point of this file. The risk in exposing the rules is not that someone
  // reads them; it's that this module quietly becomes a SECOND COPY that stops
  // matching what the writer actually applies, so MCP callers are held to a
  // standard the product no longer uses. Byte-equality with the live constants
  // is what keeps one source of truth.
  test("each section is byte-identical to the constant the writer uses", () => {
    const all = buildWritingRules([...WRITING_RULE_SECTIONS]);
    expect(all.rules.voice).toBe(GLOBAL_WRITING_SKILL);
    expect(all.rules.ai_tells).toBe(ANTI_AI_READER_TELL_RULES);
    expect(all.rules.structure).toBe(POST_STRUCTURE_SKILL);
    expect(all.rules.language).toBe(OUTPUT_LANGUAGE_RULE);
  });

  test("the format catalog covers every archetype the router knows", () => {
    expect(publicFormatCatalog().map((f) => f.id)).toEqual(
      NO_MODEL_FORMATS.map((f) => f.id),
    );
  });
});

describe("writing rules — what must not leak", () => {
  test("curated exemplar post ids are not exposed", () => {
    // exemplarPostIds are editorial picks from the tracked corpus. Handing out
    // the id list would let a caller reconstruct the curation without the
    // corpus behind it.
    const serialized = JSON.stringify(publicFormatCatalog());
    expect(serialized).not.toContain("exemplarPostIds");
    expect(serialized).not.toContain("exemplar_post_ids");
    for (const format of NO_MODEL_FORMATS) {
      for (const id of format.exemplarPostIds) {
        expect(serialized).not.toContain(id);
      }
    }
  });

  test("the archetype fields callers need are still present", () => {
    const first = publicFormatCatalog()[0];
    expect(first).toHaveProperty("when_to_use");
    expect(first).toHaveProperty("structure");
    expect(first).toHaveProperty("avoid");
  });
});

describe("buildWritingRules — section selection", () => {
  test("defaults to voice + ai_tells rather than everything", () => {
    // The full corpus is ~24k chars; returning all of it by default would evict
    // a caller's working context to deliver rules it did not ask for.
    const payload = buildWritingRules();
    expect(payload.sections).toEqual(DEFAULT_WRITING_RULE_SECTIONS);
    expect(payload.rules.structure).toBeUndefined();
    expect(payload.formats).toBeUndefined();
  });

  test("returns only the requested sections", () => {
    const payload = buildWritingRules(["structure"]);
    expect(payload.rules.structure).toBeTruthy();
    expect(payload.rules.voice).toBeUndefined();
    expect(payload.rules.ai_tells).toBeUndefined();
  });

  test("includes the format catalog only when asked", () => {
    expect(buildWritingRules(["formats"]).formats).toBeTruthy();
    expect(buildWritingRules(["voice"]).formats).toBeUndefined();
  });

  test("drops unknown section names instead of failing the call", () => {
    // A client built against a later version should degrade to the sections
    // that exist, not error out entirely.
    const payload = buildWritingRules(["voice", "not_a_section"]);
    expect(payload.sections).toEqual(["voice"]);
  });

  test("falls back to the default when nothing valid is requested", () => {
    expect(buildWritingRules(["nope"]).sections).toEqual(
      DEFAULT_WRITING_RULE_SECTIONS,
    );
  });

  test("de-duplicates repeated sections", () => {
    expect(buildWritingRules(["voice", "voice"]).sections).toEqual(["voice"]);
  });

  test("tells the caller how to apply the rules", () => {
    const note = buildWritingRules().note;
    // Two failure modes worth pre-empting: reciting the rules at the user, and
    // letting a generic rule override the author's real, evidenced habit.
    expect(note).toMatch(/not text to reproduce|do not quote/i);
    expect(note).toMatch(/voice profile|author's own voice/i);
  });
});

describe("get_writing_rules — tool surface", () => {
  test("is registered", () => {
    expect(Object.keys(registry().handlers)).toContain("get_writing_rules");
  });

  test("returns rules without needing a workspace", async () => {
    // These rules are identical for every caller, so requiring workspace
    // resolution would add a failure mode to a static read for no benefit.
    const body = await registry()
      .handlers.get_writing_rules({}, { authInfo: { extra: {} } })
      .then(json);
    expect(body.ok).toBe(true);
    expect((body.rules as Record<string, string>).voice).toBe(GLOBAL_WRITING_SKILL);
  });

  test("honours the sections argument", async () => {
    const body = await registry()
      .handlers.get_writing_rules(
        { sections: ["formats"] },
        { authInfo: { extra: { workspaceId: "ws-1" } } },
      )
      .then(json);
    expect(body.formats).toBeTruthy();
    expect((body.rules as Record<string, string>).voice).toBeUndefined();
  });

  test("its description points the caller at get_voice for precedence", async () => {
    const description = registry().configs.get_writing_rules?.description ?? "";
    expect(description).toMatch(/get_voice/);
  });
});
