# Two-model split: Gemini Flash orchestrates, Qwen writes — implementation plan

Status: PLANNED (no code yet). Owner: Daniel. Multi-session build, 5 phases + a
gating prototype phase. Each phase is one PR-sized unit (Phase 1 may be two).
Work phases strictly in order — each has an explicit GATE that must pass before
the next starts.

---

## Context & decision (settled 2026-07-14)

**Problem.** The chat agent is a single tool-calling loop where one model both
drives tools AND writes the post — `render_post` carries the finished body as a
tool argument (`lib/agent/run.ts:820`, prompt rules at `:250-271`). A live
bake-off (4 real `runAgent` tasks × 3 models) showed the bottleneck is
**tool-calling reliability, not prose**:

| Model | Tool behavior | Prose |
|---|---|---|
| GLM-5.2 (current) | Works; 2/5 tool failures on from-scratch; over-rendered "5 ideas" into 6 cards | Competent, generic |
| DeepSeek-V4-Pro | 13 calls / 6 failures / 203k input tokens on ONE draft — undisciplined | Good |
| Qwen3.7-plus | **400 on every task**: Alibaba rejects `tool_choice:"required"` in thinking mode (set at `run.ts:1880-1882`) | **Best** |

The model we want writing (Qwen) cannot tool-call in our loop; the models that
can tool-call write worse. **Separate the roles.**

**Decisions (user-confirmed):**
- Orchestrator = **Gemini 2.5 Flash** (`google/gemini-2.5-flash`, $0.30/$2.50 per 1M) — runs the tool loop, never writes the body.
- Writer = **Qwen3.7-plus** (`qwen/qwen3.7-plus`, $0.32/$1.28) — tool-less `completeChat`; never sees `tool_choice`, so the 400 cannot fire.
- Split shape = **context handoff**: orchestrator calls a new `write_post` tool whose args are *instructions/context* (not prose); the server runs the Qwen writer, then feeds the body through the existing net chain.
- Scope = **chat agent only**. The weekly batch already IS a tool-less writer (it keeps its current model config, swappable independently via env later).

**Why this is low-risk.** `dispatchRenderTool` (`run.ts:782`) is a deep module:
body-string in → corruption gate → length cap → `editDraftBodySync` →
`repairAiTells` → source-fidelity (`reviewModeledDraft`) → sameness → Artifact
out. The split changes only the body's *provenance* (orchestrator arg → writer
output). No net changes.

---

## Phase 0 — Split prototype (throwaway; the go/no-go gate)

**Goal.** Prove, with ~$0.20 of API spend and zero prod changes, that (a) Gemini
Flash reliably drives our tool loop to a `write_post` handoff, and (b) a
tool-less Qwen call given the handoff context produces a usable body.

**Deliverable.** `scripts/split-prototype.ts` (untracked throwaway, like the
other `*-ab.ts` harnesses), extending the agent-loop harness pattern:

- P0.1 — Stub a `write_post` tool def (instructions, sourcePostId?, isLeadMagnet?)
  into a Flash-driven `streamChat` loop that otherwise mirrors run.ts round 0
  (same tools list, same `toolChoice:"required"` on drafting turns).
- P0.2 — On `write_post`, assemble a writer prompt (voice + instructions +
  source text if any) and call Qwen via `completeChat` with NO tools; print body.
- P0.3 — Run the same 4 tasks as the bake-off (from-scratch, 5-ideas,
  model-a-post, refine) × 2 samples; report per task: did Flash reach
  `write_post`; tool calls/failures; Flash reasoning tokens; Qwen body quality;
  end-to-end latency; total cost.

**GATE (all must hold to proceed):**
1. Flash reaches `write_post` on every drafting task, 0 unrecovered tool failures.
2. Flash does NOT call `write_post` on the 5-ideas task (ideas stay text).
3. Qwen bodies are publishable-quality (user eyeballs them).
4. Orchestration cost/latency within ~2× of estimate (watch Flash reasoning tokens).

**Fallbacks if the gate fails:** Flash flaky → retry with Sonnet 5 as
orchestrator (P0 re-run is cheap); Qwen bodies weak with handoff context → try
the brief/outline handoff variant before abandoning. If both fail, stop: keep
GLM single-model and revisit.

**Estimated effort:** half a day. **Blocks:** everything below.

---

## Phase 1 — Core: `write_post` handoff + server-side writer (behind kill-switch)

**Goal.** The real two-model path in `run.ts`, shipped dark behind
`CHAT_TWO_MODEL` (default off → prod behavior byte-identical).

**Tickets (in order):**

- **P1.1 — `lib/agent/writer.ts` (new module, the writer seam).**
  `writePostBody(opts)` → `{ body, usage }`. Opts: `instructions`, `sourceText?`,
  `currentDraft?` (refine), `isLeadMagnet`, `voice`, `preferences`,
  `exemplarBlock`, `patternBriefBlock`, `freshnessBlock`, `workspaceId`,
  `signal`. Internals: writer system prompt assembled like
  `buildWeeklyDraftSystemBlocks` (stable cached block + variable block; the
  RAG/freshness/pattern-brief blocks live HERE now — they are writing guidance);
  user message = instructions (+ source/current-draft text);
  `completeChat({ model: WRITER_MODEL, maxTokens: DRAFT_MAX_TOKENS, timeoutMs })`
  — **no tools, no tool_choice** (the Qwen-safety invariant); 2-attempt retry on
  empty/truncated (mirror `generateDraftBody`); cost log
  `logOpenRouterUsage("chat_writer", …)` best-effort `.catch` (PR-B lesson).
  `WRITER_MODEL = env OPENROUTER_WRITER_MODEL || "qwen/qwen3.7-plus"`.

- **P1.2 — `write_post` tool def in `lib/agent/tools.ts`.**
  Params: `instructions` (required — what the post should convey: angle, hook
  direction, key points, CTA; explicitly NOT the finished prose),
  `sourcePostId?` (verified same as today), `isLeadMagnet?`, `variationIndex?`
  (N-post requests). Description teaches the orchestrator it briefs, the writer
  writes.

- **P1.3 — Interception in `run.ts`.**
  In the render dispatch: `write_post` → validate `sourcePostId` against
  `discoveredSourcePostIds` (existing source-fidelity gate, unchanged) → fetch
  source text for the writer → `writePostBody(...)` → feed the returned body
  into the EXISTING render_post net path (corruption → cap → editor → ai-tell →
  sameness → artifact). Writer failure → `ok:false` tool result ("writer
  unavailable, try again") — never an empty turn. Per-turn render cap counts
  `write_post` (cost guard on "write 5 posts"); deliverable-contract counting
  treats a `write_post` artifact as a post.

- **P1.4 — Orchestrator prompt + model config.**
  Rewrite `SYSTEM_PROMPT`'s "Producing posts" section (`run.ts:250-271`):
  `render_post(body)` → `write_post(instructions)`; keep all the ONE-post/no-
  fragments/refine=exactly-one rules, re-aimed at write_post. Keep `render_post`
  registered but hard-rejected in dispatch ("use write_post") — the
  `render_hook` backstop pattern. Add
  `ORCHESTRATOR_MODEL = env OPENROUTER_ORCHESTRATOR_MODEL || CHAT_MODEL`, thread
  into the loop's `streamChat` calls (lines ~1870, ~2958). Add pricing-table
  entries for `google/gemini-2.5-flash` + `qwen/qwen3.7-plus`.

- **P1.5 — Kill-switch.**
  `CHAT_TWO_MODEL=1` enables: write_post in the tool list + interception +
  orchestrator model override. Off (default): tool list, prompt, dispatch, and
  model identical to today — assert byte-identical in tests.

**GATE:** all Phase 4 unit/eval tests green; with the switch OFF the full suite
is untouched-green; with it ON the stubbed-writer eval produces one artifact
through the nets. **Blocks:** P2, P4. **Effort:** 1–2 days (the big one).

---

## Phase 2 — Streaming UX

**Goal.** The user still watches the post appear; tool activity chips unchanged.

- **P2.1 — Stream the writer.** Preferred: run the writer via `streamChat`
  (tool-less) and forward deltas through the existing artifact-streaming channel
  so the card fills in live. Nets run on the completed body (they already run
  post-hoc server-side — verify placement doesn't double-emit).
- **P2.2 — Fallback if P2.1 is awkward:** emit a "Writing the post…" activity
  chip when the writer starts (same event family as tool chips), then the
  finished card. Ship this first if streaming plumbing is >1 day; upgrade later.
- **P2.3 — Refine UX check:** refine still replaces in place (version stepper),
  no duplicate card (regression vs PR #396 behavior).

**GATE:** manual dogfood — a drafting turn visibly progresses (chips or live
card fill); Stop mid-write cancels the writer call (signal threading from P1.1).
**Effort:** 0.5–1 day.

---

## Phase 3 — Cost & latency validation (measure, don't trust estimates)

**Goal.** Replace the estimate table with measured numbers before rollout.

- **P3.1 —** Re-run the Phase-0 harness against the REAL Phase-1 path
  (`CHAT_TWO_MODEL=1`, dev) across every feature: original post, lead magnet,
  model-a-post, newsjack, brandjack, 5 ideas, refine. Record from `agent_turn`
  logs + `usage_events`: orchestrator in/out/reasoning tokens, writer in/out,
  latency, tool failures.
- **P3.2 —** Compare against the all-GLM baseline (same tasks, switch off).
  Estimates to beat (per generation): original ~$0.003 vs $0.006 · lead magnet
  ~$0.004 vs $0.008 · model ~$0.004 vs $0.008 · newsjack ~$0.004 vs $0.008 ·
  brandjack ~$0.003 vs $0.007 · 5 ideas ~$0.002 vs $0.006.

**GATE:** split ≤ all-GLM cost per feature (target ~2× cheaper) AND p50 latency
within +30% of baseline AND tool-failure rate strictly better than GLM's.
Flash reasoning tokens blowing the budget → cap/disable Flash reasoning, or swap
orchestrator to Sonnet 5 and re-measure. **Effort:** 0.5 day.

---

## Phase 4 — Tests (built WITH Phase 1, gate before Phase 5)

- **P4.1 — `evals/data/writer.test.ts`:** writePostBody never sends
  tools/tool_choice (assert on the mocked completeChat args — the Qwen-safety
  invariant); threads voice/exemplar/pattern/freshness blocks into the prompt;
  retries once on empty; cost-log failure doesn't throw; timeout honored;
  refine passes `currentDraft`.
- **P4.2 — runAgent eval (extend `evals/run-agent-test.ts`):** stub script where
  the orchestrator calls `write_post`; stub `writePostBody` → assert body flows
  the SAME nets (corruption reject, length cap, ai-tell) and yields exactly ONE
  artifact; writer failure → ok:false result + no empty turn.
- **P4.3 — Source-fidelity regression:** `write_post` with a wrong/missing
  `sourcePostId` on a modeled turn is rejected by the existing gate (split must
  not weaken provenance).
- **P4.4 — Backstop:** a stray `render_post` call is hard-rejected with the
  "use write_post" message (mirror the render_hook reject test).
- **P4.5 — Kill-switch:** `CHAT_TWO_MODEL` off → tool defs, prompt, and dispatch
  byte-identical to pre-split (snapshot-style assertion).
- **P4.6 — Contract/cap:** "write 3 posts" → 3 write_post calls → 3 artifacts,
  render cap + deliverable contract enforced; refine capped at ONE.

**GATE:** full suite green; the PR-#398 stability gate (repeat-run pass rate)
green on the new evals. **Effort:** folded into Phase 1 + 0.5 day.

---

## Phase 5 — Phased rollout

- **P5.1 — Ship dark.** Merge Phases 1+2+4 with `CHAT_TWO_MODEL` unset (off).
  Verify prod behavior unchanged (agent_turn logs, no new error signatures).
- **P5.2 — Dogfood.** Enable for Daniel's workspace only (env on the deployment
  or a workspace-scoped flag — decide at P5, env is fine if it's a personal
  deployment). Manually exercise every feature incl. edge turns: Stop mid-write,
  "write 5 posts", hook-swap-on-existing-post, lead-magnet with campaign.
- **P5.3 — Observe ≥3 days.** Watch `agent_turn` (tool_calls_failed, empty_turn,
  exit_reason, source_fidelity_nudged) + `usage_events` (chat_writer + chat
  spend) + the nightly stability evals. Also confirm the daily cost digest
  reflects the new split sanely.
- **P5.4 — Global on.** Flip the env for all traffic; keep the kill-switch one
  release; announce the model change in the changelog. Later cleanup PR removes
  the switch + the render_post backstop once stable.

**Rollback at any step = unset one env var.**

---

## Risk register

| Risk | Mitigation |
|---|---|
| Flash reasoning tokens inflate orchestration cost | Measured at P0/P3 gates; cap/disable reasoning or fall back to Sonnet 5 |
| Writer misses context → voice/quality regression | All context threaded explicitly in P1.1 opts; P0 eyeball gate; dogfood P5.2 |
| Refine loses its target draft | `currentDraft` opt + P4.1/P4.6 tests; render-cap-of-1 unchanged |
| Two sequential calls raise latency | Writer streaming (P2.1); Flash is fast; +30% latency gate at P3 |
| N-post requests multiply writer cost | Render cap counts write_post (P1.3); contract tests (P4.6) |
| Orchestrator hallucinates old render_post | Hard-reject backstop (P1.4, P4.4) |
| Rollout breaks something subtle | Kill-switch + dark ship + dogfood + 3-day observation (P5) |
| Provider drift (Qwen/Flash behavior changes) | Both models env-swappable; pricing table + slug-rot guard pattern already in repo |

## Explicitly out of scope
- Weekly batch writer model (already tool-less; separate one-line env change later if Qwen proves out).
- Decision pre-pass (`DECISION_MODEL` stays Sonnet 5), specialists (freshness/sameness/ai-tell/pattern-brief models unchanged).
- Any migration — no schema changes anywhere in this plan.

## Sequencing summary
P0 (gate) → P1+P4 together (dark, kill-switched) → P2 → P3 (gate) → P5.
Realistic calendar: ~3–5 working days of build spread over multiple sessions,
each phase one session, fresh context per phase per the multi-session discipline.
