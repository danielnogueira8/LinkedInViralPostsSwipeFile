import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Direct-writer gate invariants — the static guarantee behind the central
// gate in compile.ts. The tool-less direct writer can NEVER serve a live-
// news/research brief (it has no search_news tool and can only simulate the
// call in-band — prod shipped '[search_news(query="…")]' as a draft twice:
// #1568 commandCreateEligible, #1579 directStructureSource). Every claim path
// must apply the gate, and each escape happened because ONE path didn't.
// These tests pin the gate in place at both levels so a future claim path —
// or a refactor that drops the predicate — fails CI instead of shipping:
//   1. the central post-condition on useDirectWriter (create-family lanes),
//   2. each individual lane gate in compile.ts / direct-writer-policy.ts.
// ---------------------------------------------------------------------------

const COMPILE = readFileSync(
  resolve(__dirname, "../../lib/agent/turn/compile.ts"),
  "utf8",
);
const POLICY = readFileSync(
  resolve(__dirname, "../../lib/agent/direct-writer-policy.ts"),
  "utf8",
);

/** Slice `src` from `marker` to the next top-level export (or end). */
function sectionOf(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start === -1) return "";
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\nexport (?:async )?(?:function|const|type) /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("direct-writer live-news gate invariants", () => {
  test("the central useDirectWriter post-condition gates create-family lanes", () => {
    const section = sectionOf(COMPILE, "const useDirectWriter =");
    expect(section).toContain("directRefineClaimed");
    expect(section).toContain("directCreateClaimed");
    // The predicate was extracted into a named variable, so assert the gate
    // through that name AND pin the variable's own definition. Loosening this
    // to a bare "mentions the gate somewhere" check would defeat the point:
    // this suite exists because the gate escaped three separate times.
    expect(section).toContain("directCreateFreshnessGatePasses");
    expect(sectionOf(COMPILE, "const directCreateFreshnessGatePasses =")).toContain(
      "requiresLiveNewsOrResearch(effectiveUserInstruction)",
    );
    // The refine exemption must stay: editing an existing draft never needs
    // a search, so refine lanes bypass the gate deliberately.
    expect(sectionOf(COMPILE, "const directRefineClaimed")).toContain(
      "useDirectRefine || useGeneralRefine",
    );
    // Every create-family lane is in the central check — if a new lane is
    // added to compileDirectWriterEligibility's return but not here, the
    // gate silently stops covering it.
    for (const lane of [
      "useDirectPartial",
      "useDirectMulti",
      "useDirectSource",
      "useDirectOriginal",
      "useDirectLeadMagnet",
      "useDirectCreatorStyle",
    ]) {
      expect(sectionOf(COMPILE, "const directCreateClaimed")).toContain(lane);
    }
  });

  test("commandCreateEligible keeps its own live-news gate", () => {
    expect(sectionOf(COMPILE, "const commandCreateEligible")).toContain(
      "requiresLiveNewsOrResearch(effectiveUserInstruction)",
    );
  });

  test("directStructureSource keeps its own live-news gate (#1579)", () => {
    expect(sectionOf(COMPILE, "const directStructureSource")).toContain(
      "requiresLiveNewsOrResearch(effectiveUserInstruction)",
    );
  });

  test("every direct-writer-policy lane rejects live-news/research wording", () => {
    // Lanes gated by the shared unsafe-intent predicates (which include
    // LIVE_OR_SPECIALIZED_RE + RESEARCH_REQUIREMENT_RE by construction).
    for (const fn of [
      "export function isDirectOriginalPostEligible",
      "export function isDirectRefineEligible",
      "export function isDirectFindAndModelEligible",
      "export function isDirectFixedSourcePostEligible",
      "export function isDirectPartialTextEligible",
      "export function isDirectMultiPostEligible",
    ]) {
      const section = sectionOf(POLICY, fn);
      expect(
        section.length > 0 &&
          (section.includes("LIVE_OR_SPECIALIZED_RE") ||
            section.includes("RESEARCH_REQUIREMENT_RE") ||
            section.includes("hasUnsafeDirectWritingIntent") ||
            section.includes("requiresLiveNewsOrResearch")),
        `${fn} lost its live-news/research gate`,
      ).toBe(true);
    }
    // The lead-magnet lane carries the gate inline (#1579).
    expect(
      sectionOf(POLICY, "export function isDirectLeadMagnetEligible"),
    ).toContain("requiresLiveNewsOrResearch");
    // And the shared predicates still include both regexes — the lanes above
    // delegate to them.
    expect(sectionOf(POLICY, "function hasUnsafeDirectWritingIntentExceptDiscovery")).toContain(
      "LIVE_OR_SPECIALIZED_RE",
    );
    expect(sectionOf(POLICY, "function hasUnsafeDirectWritingIntentExceptDiscovery")).toContain(
      "RESEARCH_REQUIREMENT_RE",
    );
  });
});
