# Cowork Reliability Architecture v2

## Problem Statement

Cowork's most valuable job is turning a user's instruction into a useful, publish-ready LinkedIn deliverable. Today, a common writing turn still depends on one model both deciding which tools to call and writing the content inside a tool argument. Structurally valid tool output can therefore be empty, incomplete, wrongly shaped, unsourced, or low quality while still being accepted as success. Recovery also depends too heavily on the same model noticing and correcting its own failure.

This makes the product's core workflow volatile. Users can wait through a costly turn and receive no draft, the wrong deliverable, a truncated card, a fabricated anecdote, or a weak post. Provider failures, malformed tool calls, timeouts, and partial side effects can also escape as silent or confusing terminal states.

## Solution

Cowork will compile each user turn into a typed server-owned plan, route common writing requests directly to a tool-free writer, reserve a strong tool orchestrator for genuinely complex action selection, and pass every candidate draft through one server-owned finalizer before persistence or presentation.

The server—not a model—will own routing, retry limits, model fallback, final acceptance, terminal outcomes, and side-effect checkpoints. A turn will finish with a valid deliverable, a necessary clarification, a clean cancellation, or a typed recoverable error. It will never treat valid JSON alone as evidence that the user received what they requested.

## User Stories

1. As a Cowork user, I want an original-post request to return a complete post, so that I never receive a sentence fragment as a finished draft.
2. As a Cowork user, I want simple writing requests to bypass tool orchestration, so that drafts arrive faster and with fewer failure points.
3. As a Cowork user, I want my stored voice and preferences to reach the writer automatically, so that I do not need to restate them.
4. As a Cowork user, I want the writer to follow my requested topic, angle, framework, and constraints, so that the result matches my actual instruction.
5. As a Cowork user, I want exact post or variation counts to be enforced, so that requesting two posts never produces one or three.
6. As a Cowork user, I want character limits to be enforced before presentation, so that the draft is usable where I intend to publish it.
7. As a Cowork user, I want a refine request to replace the intended draft with one complete revision, so that partial or duplicate cards never appear.
8. As a Cowork user, I want clarification answers to resume the pending writing job directly, so that Cowork does not repeat questions or restart research.
9. As a Cowork user, I want an attached or selected source to remain the verified source for the draft, so that modeled content preserves provenance.
10. As a Cowork user, I want no-search instructions to be honored, so that Cowork does not spend time or credits on unwanted discovery.
11. As a Cowork user, I want news-based writing to fail closed when no fresh result exists, so that evergreen memory is not presented as current news.
12. As a Cowork user, I want unsupported personal anecdotes, clients, results, numbers, and timelines rejected, so that the post does not invent my life.
13. As a Cowork user, I want corrupted markup and leaked tool syntax rejected, so that only clean prose reaches a draft card.
14. As a Cowork user, I want intentional short or unpunctuated LinkedIn endings preserved, so that reliability checks do not flatten my style.
15. As a Cowork user, I want a rejected candidate repaired automatically, so that I receive a usable result without understanding the failure.
16. As a Cowork user, I want a secondary writer to recover when the primary writer times out or truncates, so that one provider does not end my turn.
17. As a Cowork user, I want a clear retry action when both writers fail, so that the conversation never ends as a blank bubble.
18. As a Cowork user, I want complex research turns to use a reliable orchestrator, so that searches and actions occur in the right order.
19. As a Cowork user, I want completed searches and saves checkpointed, so that fallback never repeats paid work or side effects.
20. As a Cowork user, I want cancellation to stop orchestration, writing, finalization, and polling, so that Stop truly stops the turn.
21. As a Cowork user, I want an honest writing activity state, so that I know the system is working without seeing internal chain-of-thought.
22. As a Cowork user, I want one canonical draft card per deliverable, so that chat prose and the artifact panel never duplicate the same output.
23. As a Cowork user, I want every delivered draft persisted before it appears as canonical, so that reloads never lose or mutate the result.
24. As a Cowork user, I want the fastest suitable path selected automatically, so that simple jobs do not pay complex-job latency.
25. As a workspace owner, I want model and provider fallback bounded by cost controls, so that reliability does not create runaway spend.
26. As a workspace owner, I want direct-writing turns to cost substantially less than current large-context agent turns, so that Cowork remains economically sustainable.
27. As an operator, I want every turn to record its route, stages, attempts, rejection reasons, latency, tokens, cost, and outcome, so that failures are diagnosable.
28. As an operator, I want adapter health and circuit breakers, so that traffic leaves a degraded provider before users repeatedly fail.
29. As an operator, I want production-shaped repeated evaluations for every critical journey, so that launch claims reflect real variance rather than one successful demo.
30. As an operator, I want injected provider, JSON, timeout, truncation, and cancellation failures to end safely, so that expected infrastructure faults never become orphaned turns.
31. As a product owner, I want blind quality comparisons for voice, usefulness, factuality, and completeness, so that cheaper writing does not lower the product standard.
32. As a product owner, I want outcome gates tied to user-visible hard failures, so that valid tool syntax cannot hide a failed outcome.

## Implementation Decisions

- A deterministic turn compiler will produce one authoritative turn plan from trusted user instructions and server state.
- Common original, refine, clarification-completion, fixed-source, no-search, and self-contained partial-writing journeys will route directly to the draft engine without a tool orchestrator.
- Complex news, research, multi-source, ambiguous, file-inspection, and action-management journeys may use a dedicated orchestrator.
- The primary complex orchestrator will be Claude Sonnet 5 with low reasoning. Gemini 3.5 Flash will be the cross-provider fallback and an evaluation candidate.
- The orchestrator will choose and sequence typed actions only. It will never write a finished post body.
- The primary writer will be Qwen3.7 Plus with tools absent, tool choice absent, and reasoning disabled. GLM-5.2 will be the writer fallback.
- Writer model choice will remain behind adapters and configuration so evaluation can reverse or replace candidates without changing domain logic.
- The draft engine will own voice, preferences, trusted context, source text, writer selection, token accounting, retry, fallback, and cancellation.
- The caller will pass domain inputs and constraints, not prompt fragments, raw voice blocks, model slugs, or provider-specific options.
- A single draft finalizer will own non-empty checks, corruption checks, completeness, exact deliverable contracts, character limits, grounding, factual specificity, provenance, source fidelity, deterministic editing, AI-tell repair, sameness review, artifact construction, and validation.
- Every chat draft delivery path will cross the finalizer before persistence or presentation, including direct writing, orchestrated writing, legacy recovery, and refine flows.
- A finalizer rejection will return typed reasons to the draft engine. The server will allow one bounded repair and then activate writer fallback according to policy.
- A writer or provider failure will never trigger a blind replay after a committed side effect.
- External actions will use stable operation keys and persisted checkpoints so a fallback orchestrator can resume safely.
- Every claimed turn will end in exactly one terminal domain outcome: delivered, clarified, cancelled, recoverable error, or hard failure.
- Empty or invalid output will never be represented as a successful terminal outcome.
- OpenRouter provider fallback and parameter compatibility enforcement will remain enabled where applicable.
- Direct writing has a p95 latency target of 30 seconds. Complex journeys target p95 at 60 seconds and p99 at 90 seconds.
- User-visible hard failures must remain below 0.5%, with alerting at 0.5% and rollback or circuit breaking at 1% over a meaningful rolling sample.
- The initial model-layer planning estimate is approximately $16.75 per 1,000 mixed Cowork turns with Sonnet orchestration, or $14.03 with Gemini orchestration, before specialist and search costs.
- Model selection will be decided by production-shaped reliability, latency, blind quality, and charged cost—not headline benchmarks alone.
- The emergency incomplete-draft guard remains valuable defense in depth but does not substitute for the finalizer or writer split.

## Testing Decisions

- Tests will assert user-visible outcomes and persisted domain state rather than private prompt text or model reasoning.
- The primary acceptance seam is the draft finalizer. Scripted candidates and specialists will prove that rejected drafts cannot become artifacts.
- The writer seam will use an in-memory scripted adapter to deterministically exercise success, truncation, timeout, repair, fallback, and cancellation.
- Agent-loop tests will verify that direct and legacy paths cannot bypass finalization and that exact counts and refine semantics remain correct.
- The authenticated chat-stream route is the production-shaped seam. Its harness will assert persisted messages, artifacts, tools/actions, terminal outcome, model stages, tokens, latency, and cost.
- Existing deterministic agent integrity, draft output policy, transport, turn lifecycle, cancellation, source fidelity, news fail-closed, and artifact persistence tests are prior art and must remain green.
- Failure injection will cover timeout before first token, mid-stream disconnect, invalid JSON, schema mismatch, wrong or repeated action, provider 429/5xx, empty or truncated writer output, finalizer rejection, cancellation at each stage, and fallback before and after a checkpoint.
- Each critical journey must complete at least 300 production-shaped runs with zero user-visible hard failures before global release.
- Each writing class will receive at least twenty blind comparisons, with usefulness, voice, factuality, completeness, and preference scored separately.
- Release gates will compare the new path against the hardened baseline for failure rate, contract correctness, p50/p95/p99 latency, fallback rate, tokens, actual cost, and blind quality.
- If the hardened single-model path matches the split architecture on reliability and quality, the simpler path will be retained.

## Out of Scope

- Replacing weekly batch drafting in the first release.
- Replacing every existing specialist model.
- Rewriting the entire agent loop in one pull request.
- Removing the hardened contracts already protecting the current path.
- Publishing or scheduling without the user's existing explicit action flow.
- Claiming literal zero failure or statistical proof from a handful of manual tests.
- Choosing the cheaper orchestrator solely to save a few dollars per thousand turns.
- Exposing hidden model reasoning or chain-of-thought to users or logs.

## Further Notes

- The implementation will ship as small, blocker-aware tracer bullets. Each slice must remain deployable and must preserve the current path behind flags until its replacement clears the rollout gate.
- The first priority is one real finalization seam and a production-shaped harness. Both improve reliability even if the eventual model split changes.
- The second priority is the tool-free direct writer path because it removes the largest source of simple-turn volatility and cost.
- The complex orchestrator should be introduced only after direct writing is proven, and only for journeys where multiple materially different action sequences exist.
- Live browser validation can resume when the preview session is available; it is not a blocker for deterministic implementation work.
