import {
  structuralViolations,
  countEmDashes,
  wordCount,
  type Violation,
} from "@/lib/anti-slop-detectors";

// ---------------------------------------------------------------------------
// Run a draft through the deterministic quality bar.
//
// get_writing_rules hands an external agent the standard; this tells it whether
// the draft it just wrote actually MET the standard. Rules alone rely on the
// caller's model policing itself, which is exactly what these detectors exist
// because models are bad at.
//
// No model call: every finding is a matched pattern with a span, so the caller
// can act on it without a second opinion, the same input always produces the
// same verdict, and the check costs us nothing per call.
//
// The detectors are deliberately CONSERVATIVE (see anti-slop-detectors.ts) —
// they fire on clear patterns so a legitimately human draft is not flagged.
// That bias is right here too: a false positive sends an agent rewriting good
// copy, which is worse than missing a marginal case.
// ---------------------------------------------------------------------------

/**
 * Severity split.
 *
 * `blocking` rules are the reader-facing tells — the ones a human actually
 * notices and names as "this reads like AI". `advisory` rules are real signals
 * but noisier: a long post can legitimately run several similar-length
 * sentences, and failing a draft on that would train callers to ignore the
 * tool. Only blocking findings set `passed: false`.
 *
 * This mirrors headlineViolations() in the detector module, which the live eval
 * gates on for the same reason.
 */
const BLOCKING_RULES = new Set([
  "rule-of-three",
  "dismissive-negation",
  "repeated-opener",
  "negative-parallelism",
  "banned-word",
  "em-dash-cap",
]);

/** Plain-language guidance per rule, so a finding is actionable on its own. */
const RULE_GUIDANCE: Record<string, string> = {
  "rule-of-three":
    "Triads read as AI cadence. Keep the strongest item, use two, or use four with one oddly specific entry.",
  "dismissive-negation":
    "Rewrite as a direct claim instead of dismissing alternatives to arrive at the point.",
  "repeated-opener":
    "Three or more consecutive sentences starting the same way is a rhythm tell. Vary the openers.",
  "negative-parallelism":
    "\"It's not X, it's Y\" is the single most recognizable AI construction. State Y directly.",
  "banned-word":
    "Stock AI vocabulary. Replace with the plain word or a concrete specific.",
  "em-dash-cap":
    "Too many em dashes. Keep at most one unless the author's voice profile shows they genuinely write this way.",
  "uniform-sentence-length":
    "Several consecutive sentences of near-identical length reads as machine-even. Break the rhythm with one very short or very long sentence.",
  parataxis:
    "A run of blunt chained sentences is the staccato LinkedIn cadence that now reads as AI-fluent. Let some sentences run.",
};

export type DraftFinding = {
  rule: string;
  detail: string;
  severity: "blocking" | "advisory";
  guidance: string;
};

export type DraftCheckResult = {
  passed: boolean;
  word_count: number;
  em_dashes: number;
  blocking_count: number;
  advisory_count: number;
  findings: DraftFinding[];
  summary: string;
};

const MAX_FINDINGS = 40;

function toFinding(violation: Violation): DraftFinding {
  const severity = BLOCKING_RULES.has(violation.rule) ? "blocking" : "advisory";
  return {
    rule: violation.rule,
    detail: violation.detail,
    severity,
    guidance:
      RULE_GUIDANCE[violation.rule] ??
      "Revise this pattern; it reads as machine-generated.",
  };
}

/**
 * Check a draft.
 *
 * Blank input returns `passed: false` with an explicit summary rather than a
 * clean bill of health — "no text" must never look like "no problems", which is
 * how an empty draft would sail through a caller's own gate.
 */
export function checkDraft(body: string): DraftCheckResult {
  const text = (body ?? "").trim();
  if (!text) {
    return {
      passed: false,
      word_count: 0,
      em_dashes: 0,
      blocking_count: 0,
      advisory_count: 0,
      findings: [],
      summary: "The draft is empty, so there is nothing to check.",
    };
  }

  const findings = structuralViolations(text)
    .map(toFinding)
    // Blocking first: a caller that reads only the head of the list should see
    // the problems that actually matter.
    .sort((a, b) => {
      if (a.severity === b.severity) return a.rule.localeCompare(b.rule);
      return a.severity === "blocking" ? -1 : 1;
    });

  const blocking = findings.filter((f) => f.severity === "blocking");
  const advisory = findings.filter((f) => f.severity === "advisory");
  const shown = findings.slice(0, MAX_FINDINGS);

  return {
    passed: blocking.length === 0,
    word_count: wordCount(text),
    em_dashes: countEmDashes(text),
    // Counts describe ALL findings, not the truncated list, so a caller cannot
    // read a capped response as a complete one.
    blocking_count: blocking.length,
    advisory_count: advisory.length,
    findings: shown,
    summary:
      blocking.length === 0
        ? advisory.length === 0
          ? "No structural AI tells detected."
          : `No blocking tells. ${advisory.length} advisory note${advisory.length === 1 ? "" : "s"} worth a look.`
        : `${blocking.length} blocking AI tell${blocking.length === 1 ? "" : "s"} to fix before publishing.`,
  };
}
