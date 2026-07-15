import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const journey = z.enum([
  "original_post",
  "refine",
  "fixed_source",
  "partial",
  "multi_post",
  "no_search",
  "research_write",
  "saved_draft_action",
  "clarification_completion",
  "fresh_news_fail_closed",
  "cancellation",
  "retry_recovery",
]);
const writingClass = z.enum([
  "original",
  "refine",
  "fixed_source",
  "partial",
  "multi_post",
  "research_write",
]);
const architecture = z.enum(["baseline", "v2"]);
const writerCandidates = new Set(["qwen/qwen3.7-plus", "z-ai/glm-5.2"]);
const safeIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:/+-]+$/);
const nonnegative = z.number().finite().nonnegative();
const runSchema = z
  .object({
    runId: safeIdentifier,
    architecture,
    journey,
    variantId: safeIdentifier,
    modelComparisonGroup: safeIdentifier.optional(),
    evidenceSource: z.enum(["scripted", "live"]),
    productionShaped: z.boolean(),
    costObserved: z.boolean(),
    contractPassed: z.boolean(),
    terminalOutcome: z.enum([
      "delivered",
      "clarified",
      "cancelled",
      "recoverable_error",
      "hard_failure",
    ]),
    fallbackUsed: z.boolean(),
    latencyMs: nonnegative,
    inputTokens: nonnegative,
    outputTokens: nonnegative,
    reasoningTokens: nonnegative,
    cachedInputTokens: nonnegative,
    chargedCostUsd: nonnegative,
    orchestratorModel: safeIdentifier.optional(),
    writerModel: safeIdentifier.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.costObserved && run.evidenceSource !== "live") {
      context.addIssue({
        code: "custom",
        message: "Only live provider evidence can mark costObserved true.",
      });
    }
  });
const scores = z
  .object({
    usefulness: z.number().min(1).max(5),
    voice: z.number().min(1).max(5),
    factuality: z.number().min(1).max(5),
    completeness: z.number().min(1).max(5),
  })
  .strict();
const candidate = z
  .object({
    candidateId: safeIdentifier,
    architecture,
    orchestratorModel: safeIdentifier.optional(),
    writerModel: safeIdentifier.optional(),
    scores,
  })
  .strict();
const comparisonSchema = z
  .object({
    comparisonId: safeIdentifier,
    comparisonKind: z.enum(["architecture", "writer_model"]),
    writingClass,
    blind: z.literal(true),
    candidates: z.tuple([candidate, candidate]),
    preferredCandidateId: safeIdentifier.or(z.literal("tie")),
  })
  .strict()
  .superRefine((comparison, context) => {
    const candidateIds = comparison.candidates.map((item) => item.candidateId);
    if (new Set(candidateIds).size !== 2) {
      context.addIssue({ code: "custom", message: "Candidate IDs must be distinct." });
    }
    if (
      comparison.comparisonKind === "architecture" &&
      new Set(comparison.candidates.map((item) => item.architecture)).size !== 2
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An architecture comparison requires one baseline and one v2 candidate.",
      });
    }
    if (comparison.comparisonKind === "writer_model") {
      const writerModels = comparison.candidates.map((item) => item.writerModel);
      const orchestratorModels = comparison.candidates.map(
        (item) => item.orchestratorModel ?? "direct",
      );
      if (
        comparison.candidates.some((item) => item.architecture !== "v2") ||
        writerModels.some((model) => !model) ||
        new Set(writerModels).size !== 2 ||
        writerModels.some((model) => !writerCandidates.has(model))
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A writer-model comparison requires two v2 candidates with distinct writer models.",
        });
      }
      if (new Set(orchestratorModels).size !== 1) {
        context.addIssue({
          code: "custom",
          message:
            "A writer-model comparison must hold the orchestrator model constant.",
        });
      }
    }
    if (
      comparison.preferredCandidateId !== "tie" &&
      !candidateIds.includes(comparison.preferredCandidateId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Preferred candidate must be one of the blinded candidates.",
      });
    }
  });
const browserSchema = z
  .object({
    desktop: z.enum(["passed", "failed", "pending"]),
    mobile: z.enum(["passed", "failed", "pending"]),
  })
  .strict();
const evidenceSchema = z
  .object({
    runs: z.array(runSchema),
    blindComparisons: z.array(comparisonSchema),
    browserValidation: browserSchema.optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    for (const [path, values] of [
      ["runs", evidence.runs.map((run) => run.runId)],
      [
        "blindComparisons",
        evidence.blindComparisons.map((comparison) => comparison.comparisonId),
      ],
    ]) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} IDs must be unique.`,
        });
      }
    }
  });
const envelopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run"), data: runSchema }).strict(),
  z
    .object({ type: z.literal("blind_comparison"), data: comparisonSchema })
    .strict(),
  z
    .object({ type: z.literal("browser_validation"), data: browserSchema })
    .strict(),
]);

const forbiddenKey =
  /(?:prompt|draft|body|content|credential|secret|api_?key|reasoning_(?:text|content|details))/i;

export function assertSafeEvidenceKeys(value, path = "evidence") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenKey.test(key)) {
      throw new Error(`Unsafe evidence field at ${path}.${key}.`);
    }
    assertSafeEvidenceKeys(nested, `${path}.${key}`);
  }
}

export function parseEvidenceInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return evidenceSchema.parse({ runs: [], blindComparisons: [] });
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
  if (
    (Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((item) => item?.type)) ||
    (!Array.isArray(parsed) && parsed?.type)
  ) {
    const envelopes = z
      .array(envelopeSchema)
      .parse(Array.isArray(parsed) ? parsed : [parsed]);
    const browserRecords = envelopes.filter(
      (item) => item.type === "browser_validation",
    );
    if (browserRecords.length > 1) {
      throw new Error("Evidence can contain only one browser validation record.");
    }
    parsed = {
      runs: envelopes.filter((item) => item.type === "run").map((item) => item.data),
      blindComparisons: envelopes
        .filter((item) => item.type === "blind_comparison")
        .map((item) => item.data),
      browserValidation: envelopes.find((item) => item.type === "browser_validation")?.data,
    };
  }
  assertSafeEvidenceKeys(parsed);
  return evidenceSchema.parse(parsed);
}

async function loadEvidenceBuilder(projectRoot) {
  const temporary = mkdtempSync(join(tmpdir(), "cowork-v2-report-"));
  try {
    const source = join(projectRoot, "lib/agent/cowork-rollout-evidence.ts");
    const tsc = join(projectRoot, "node_modules/typescript/bin/tsc");
    execFileSync(process.execPath, [
      tsc,
      source,
      "--target",
      "ES2022",
      "--module",
      "commonjs",
      "--moduleResolution",
      "node",
      "--skipLibCheck",
      "--outDir",
      temporary,
    ]);
    const compiled = join(temporary, "cowork-rollout-evidence.js");
    const compiledModule = await import(pathToFileURL(compiled).href);
    return compiledModule.buildCoworkRolloutEvidence;
  } finally {
    // The import is complete before cleanup; no generated code enters the repo.
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(scriptPath), "..");
  const inputPath = resolve(process.argv[2] ?? "artifacts/cowork-v2-evidence.jsonl");
  const outputPath = resolve(
    process.argv[3] ?? "artifacts/cowork-v2-rollout-report.json",
  );
  if (!existsSync(inputPath)) {
    throw new Error(`Evidence input not found: ${inputPath}`);
  }
  const evidence = parseEvidenceInput(readFileSync(inputPath, "utf8"));
  const buildCoworkRolloutEvidence = await loadEvidenceBuilder(projectRoot);
  const report = buildCoworkRolloutEvidence(evidence);
  const output = {
    generatedAt: new Date().toISOString(),
    sourceFile: basename(inputPath),
    ...report,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Cowork v2 rollout gate: ${report.promotion.status}; ${report.runs.overall.runs} runs; ${report.promotion.blockers.length} blockers.`,
  );
  if (report.promotion.status !== "passed") process.exitCode = 2;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(`Cowork v2 rollout report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
