import { stripArtifactFences } from "@/lib/artifact-fences";
import type { Artifact, PlanStep } from "@/lib/agent/contracts";
import {
  executeAcceptedChatTurn,
  type ChatTurnOutcome,
} from "@/lib/agent/chat-turn-lifecycle";
import { resolveTurnOutcome } from "@/lib/agent/turn/outcome";
import type { TurnPlan } from "@/lib/agent/turn/compile";
import type { TurnSetupResult } from "@/lib/agent/turn/setup";
import type { ExecuteTurnPlanResult } from "@/lib/agent/turn/execute";
import { persistChatAssistantTurn } from "@/lib/chat-message-persistence";
import type { CoworkTurnUsageWire } from "@/lib/cowork-turn-usage";
import { encodeChatSseFrame } from "@/lib/transport/contracts";
import {
  configuredSseHeartbeatInterval,
  startSseHeartbeat,
} from "@/lib/transport/sse-heartbeat";
import { contentFormatForModel } from "@/lib/markdown/mode";
import { CHAT_MODEL, type ToolCall } from "@/lib/openrouter";
import type { ModeledDraftBatchContinuation } from "@/lib/agent/modeled-draft-continuation";
import { TurnOutcomeInvariantError } from "@/lib/agent/turn/outcome-guard";
import { persistedCiteMeta } from "@/lib/agent/grounded-source-citations";

const CHAT_SSE_HEARTBEAT_MS = configuredSseHeartbeatInterval(
  Number(process.env.CHAT_SSE_HEARTBEAT_MS || 15_000),
);

export type TurnFinalizeDependencies = {
  chatId: string;
  releaseChatTurn: (
    workspaceId: string,
    chatId: string,
    operationKey: string | null,
  ) => Promise<void>;
  signal: AbortSignal;
};

export type FinalizeTurnResult = {
  stream: ReadableStream;
  claimedTurnStartedAt: string | null;
  claimedUserMessageId: string | null;
  terminal: Promise<ChatTurnOutcome>;
};

export type RecoverableMarker = {
  code: string | number;
  message: string;
  retryRootUserMessageId?: string;
  continuation?: ModeledDraftBatchContinuation;
};

export function recoverableErrorValue(
  marker: RecoverableMarker,
): Record<string, unknown> {
  return {
    code: String(marker.code ?? ""),
    message: marker.message,
    ...(marker.retryRootUserMessageId
      ? { retryRootUserMessageId: marker.retryRootUserMessageId }
      : {}),
    ...(marker.continuation ? { continuation: marker.continuation } : {}),
  };
}

export function persistedFailureContent(
  cause: unknown,
  streamedText: string,
): string {
  return cause instanceof TurnOutcomeInvariantError
    ? "⚠️ Cowork discarded a response that did not match the authorized operation. Nothing was changed."
    : stripArtifactFences(streamedText) ||
        "⚠️ The assistant hit an error and couldn't finish this response.";
}

/**
 * Finalize a compiled, ready-to-run turn into an SSE response stream.
 *
 * This isolates the transport framing, persistence, outcome resolution, and
 * claim-release glue from turn setup and execution dispatch. It consumes the
 * AgentEvent stream produced by `executeTurnPlan().run()`, forwards each event
 * as an SSE frame, persists the assistant turn, and resolves the terminal
 * outcome for telemetry.
 */
export function finalizeTurn(
  plan: TurnPlan,
  setup: TurnSetupResult,
  executeResult: ExecuteTurnPlanResult,
  deps: TurnFinalizeDependencies,
): FinalizeTurnResult {
  const { chatId, signal } = deps;
  const {
    workspaceId,
    sbRaw,
    turnCostOperationKey,
    claimedTurnStartedAt,
    claimedUserMessageId,
    coworkTelemetry,
  } = setup;

  const {
    activeModeledBatchContinuation,
    modeledBatchRetryRootUserMessageId,
  } = plan;

  const encoder = new TextEncoder();
  let resolveTerminal!: (outcome: ChatTurnOutcome) => void;
  const terminal = new Promise<ChatTurnOutcome>((resolve) => {
    resolveTerminal = resolve;
  });
  // Once the client disconnects, the underlying controller is closed/errored and
  // enqueuing to it throws `Invalid state: Controller is already closed`. Guard
  // every write behind a `closed` flag (set in finally and on stream cancel) and
  // swallow any residual enqueue error, so a late event on a torn-down stream
  // can't throw out of `start` and skip persistence / double-close.
  let closed = false;
  let stopHeartbeat = () => {};
  const send = (
    controller: ReadableStreamDefaultController,
    event: string,
    data: unknown,
  ) => {
    if (closed) return;
    const frame = encodeChatSseFrame(event, data);
    if (!frame) {
      console.error(JSON.stringify({ chat_sse_contract_violation: { event } }));
      const fallback = encodeChatSseFrame("error", {
        message: "The assistant stream produced an invalid event.",
        code: "invalid_stream_event",
      });
      try {
        if (fallback) controller.enqueue(encoder.encode(fallback));
      } catch {
        // The consumer may already have disconnected.
      }
      closed = true;
      return;
    }
    try {
      controller.enqueue(encoder.encode(frame));
    } catch {
      // Controller already closed (client gone) — stop trying to write.
      closed = true;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      // Provider reasoning can be silent for longer than the browser's 55s
      // transport watchdog. Send SSE comments (ignored by the event parser)
      // so a healthy, still-running model round is never mistaken for a dead
      // connection and cancelled before its first tool call arrives.
      stopHeartbeat = startSseHeartbeat({
        intervalMs: CHAT_SSE_HEARTBEAT_MS,
        write: () => {
          if (closed) return;
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        },
      });
      const artifacts: Artifact[] = [];
      // Accumulate streamed text + whether we've already persisted the assistant
      // turn, so an error/abort mid-stream still saves a row (otherwise the user
      // message is orphaned with no reply, which corrupts the next turn's
      // history).
      let streamedText = "";
      let persisted = false;
      let responseModel = CHAT_MODEL;
      const recordResponseModel = (model: string) => {
        responseModel = model;
      };
      // Persist the current plan to chats.live_plan so a client that navigated
      // away mid-turn and came back can restore the literal checklist (not just a
      // "still working…" indicator). Never throws (a failed write only costs the
      // returning client its checklist, never the turn). Plans change a few times
      // per turn (not per token), so the write volume is small. Returns the
      // promise so the finally can AWAIT the NULL-clear specifically — awaiting it
      // before releaseChatTurn guarantees the clear lands before the NEXT turn
      // (which can only claim after release) writes its first plan, so a stale
      // clear can't null a newer turn's live_plan.
      const persistLivePlan = (steps: PlanStep[] | null): Promise<void> =>
        Promise.resolve(
          sbRaw
            .from("chats")
            .update({ live_plan: steps && steps.length ? steps : null })
            .eq("id", chatId)
            .eq("workspace_id", workspaceId),
        ).then(
          () => {},
          () => {},
        );
      // Returns true iff the assistant row was actually committed. The Supabase
      // JS client RESOLVES with { error } (it does not throw), so a bare
      // `await insert()` swallows a failed write — and this is the app's single
      // most important save path. If the assistant insert fails we would send
      // `done` over a reply that was never stored, leaving the user's message
      // orphaned with no answer on reload, silently. So we check every { error }
      // and, on the assistant-row failure, return false so the caller surfaces a
      // recoverable error instead of a false `done`.
      const persistAssistant = async (
        content: string,
        toolCalls: ToolCall[] | null,
        terminalReason: "done" | "ask" | "cancelled" | "deadline" | "error",
        tokens?: { input: number; output: number },
        toolMessages?: { content: string; tool_call_id: string | null }[],
        recoverableError?: Record<string, unknown> | null,
        turnUsage?: CoworkTurnUsageWire | null,
      ): Promise<boolean> => {
        if (persisted) return true;
        persisted = true;
        // Persist cite artifacts without the resolved meta.card snapshot.
        // Engagement counts and media URLs drift, so the card is RE-RESOLVED
        // fresh on chat load. A server-validated LinkedIn post URL may remain
        // as the immediate-render fallback while that rehydration settles.
        //
        // post/hook drafts: stamp meta.markdown when the writer model emits
        // markdown (GPT-5.6 Luna), so every downstream egress (render, publish,
        // copy) normalizes the body. For a non-markdown model this adds nothing —
        // the meta is untouched — keeping Haiku/GLM/Gemini drafts byte-identical
        // and the OPENROUTER_CHAT_MODEL rollback clean.
        const persistArtifacts = artifacts.map((a) => {
          if (a.kind === "cite") {
            return {
              ...a,
              meta: persistedCiteMeta(a.meta),
            };
          }
          return a;
        });
        const { error: asstErr } = await persistChatAssistantTurn({
          sb: sbRaw,
          chatId,
          workspaceId,
          content,
          toolCalls,
          artifacts: persistArtifacts.length ? persistArtifacts : null,
          inputTokens: tokens?.input ?? null,
          outputTokens: tokens?.output ?? null,
          toolMessages: toolMessages ?? [],
          terminalReason,
          contentFormat: contentFormatForModel(responseModel),
          recoverableError,
          turnUsage,
        });
        if (asstErr) {
          // THE critical failure: the reply wasn't stored. Metric it (grep
          // `assistant_persist_failed`) and report failure so the caller sends
          // an error frame instead of `done`.
          console.error(
            JSON.stringify({
              assistant_persist_failed: {
                stage: "assistant",
                chat_id: chatId,
                workspace_id: workspaceId,
                error: asstErr.message,
              },
            }),
          );
          return false;
        }
        const { error: bumpErr } = await sbRaw
          .from("chats")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", chatId)
          .eq("workspace_id", workspaceId);
        // The reply IS saved; a failed recency bump only mis-sorts the sidebar.
        // Log but still report success.
        if (bumpErr) {
          console.error(
            JSON.stringify({
              assistant_persist_failed: {
                stage: "chat_bump",
                chat_id: chatId,
                error: bumpErr.message,
              },
            }),
          );
        }
        return true;
      };
      // Set when a recoverable error frame is emitted this turn; a recoverable
      // error is followed by a `done` that persists the reply, so we stash this
      // on the assistant row there to keep the Continue banner across reloads.
      let recoverableMarker: RecoverableMarker | null = null;

      const { run } = executeResult;

      const outcome = await executeAcceptedChatTurn({
        signal,
        run: () => run({ signal, onModelUsed: recordResponseModel }),
        persist: async (ev) => {
          switch (ev.type) {
            case "text":
              streamedText += ev.delta;
              send(controller, "text", { delta: ev.delta });
              break;
            case "tool_start":
              send(controller, "tool_start", {
                id: ev.id,
                name: ev.name,
                args: ev.args,
              });
              break;
            case "tool_end":
              send(controller, "tool_end", {
                id: ev.id,
                name: ev.name,
                ok: ev.ok,
                // Deterministic finding for the activity chip (may be absent).
                ...(ev.summary ? { summary: ev.summary } : {}),
              });
              break;
            case "plan":
            case "plan_update":
              // The agent's live task checklist. Both events carry the FULL
              // ordered step list (client replaces, doesn't merge). Not persisted
              // with the finished message, but MIRRORED to chats.live_plan while
              // in flight so a client that navigated away and back restores the
              // checklist (cleared on settle in the finally below).
              void persistLivePlan(ev.steps);
              send(controller, ev.type, { steps: ev.steps });
              break;
            case "ask":
              // The agent asked a clarifying question and ended the turn. Live-
              // only (the question text also rides in done.content for reload
              // context); the interactive card renders from this event.
              send(controller, "ask", ev.ask);
              break;
            case "preference_saved":
              // The agent saved a durable writing preference. Live-only signal
              // for a lightweight "I'll remember that — undo?" affordance; the
              // rule is persisted + editable in the Voice tab, so nothing needs
              // to ride in `done` for reload.
              send(controller, "preference_saved", {
                id: ev.id,
                rule: ev.rule,
              });
              break;
            case "artifact":
              artifacts.push(ev.artifact);
              send(controller, "artifact", ev.artifact);
              break;
            case "done": {
              // If a recoverable error preceded this done, stash the marker on
              // the assistant row so hydrate can re-derive the Continue banner
              // after the post-stream reload (recoverable is otherwise live-only).
              const turnUsage = coworkTelemetry.snapshotUsage();
              // A modeled coordinator can cross its deadline at a cancellation
              // boundary after producing a result, without first yielding an
              // error frame. Persist the same server marker in that path so a
              // second Retry still resolves to the original durable batch.
              const persistedRecoverableMarker =
                recoverableMarker ??
                (modeledBatchRetryRootUserMessageId &&
                ev.terminalReason === "deadline"
                  ? {
                      code: "modeled_batch_deadline",
                      message:
                        ev.message.content ||
                        "The modeled set reached its deadline. Retry will continue the same batch.",
                      retryRootUserMessageId:
                        modeledBatchRetryRootUserMessageId,
                    }
                  : null);
              const doneToolCalls = ev.message.tool_calls ?? [];
              const saved = await persistAssistant(
                ev.message.content,
                doneToolCalls,
                ev.terminalReason ?? "done",
                {
                  input: ev.message.inputTokens,
                  output: ev.message.outputTokens,
                },
                ev.message.toolMessages.map((t) => ({
                  // Tool messages always carry string content.
                  content: typeof t.content === "string" ? t.content : "",
                  tool_call_id: t.tool_call_id ?? null,
                })),
                persistedRecoverableMarker
                  ? recoverableErrorValue(persistedRecoverableMarker)
                  : null,
                turnUsage,
              );
              if (!saved) {
                // The reply was generated but the DB save failed. Do NOT send a
                // `done` over a reply that isn't stored (it would vanish on
                // reload). Surface a recoverable error — the turn's work is done,
                // so retrying re-runs it cleanly. (Metric already logged.)
                send(controller, "error", {
                  message:
                    "Your reply was generated but couldn't be saved. Please try again.",
                  code: "persist_failed",
                  recovery: "continue",
                });
                const persistenceError = new Error(
                  "Assistant turn persistence failed.",
                );
                persistenceError.name = "AssistantPersistenceError";
                return {
                  ok: false as const,
                  error: persistenceError,
                };
              }
              send(controller, "done", { artifacts, usage: turnUsage });
              break;
            }
            case "error":
              // RECOVERABLE errors (length_truncated, tool_budget_exhausted)
              // are followed by a `done` event with the proper finalText —
              // skip persisting here and let `done` carry the canonical
              // content. The error frame is purely a UI signal (show the
              // Continue button). Non-recoverable errors (provider 5xx,
              // rate limits, content filter) DON'T get a `done` event, so we
              // persist here to make sure the user's turn isn't orphaned.
              if (!ev.recovery) {
                await persistAssistant(
                  stripArtifactFences(streamedText) ||
                    "⚠️ The assistant hit an error and couldn't finish this response.",
                  null,
                  "error",
                );
              } else {
                // Recoverable: the `done` that follows will persist the reply.
                // Remember the banner so it's stashed on that row for reloads.
                const resumesDurableModeledBatch =
                  modeledBatchRetryRootUserMessageId &&
                  typeof ev.code === "string" &&
                  ev.code.startsWith("modeled_batch_resumable_");
                recoverableMarker = {
                  code: ev.code ?? "",
                  message: ev.message,
                  ...(modeledBatchRetryRootUserMessageId
                    ? {
                        retryRootUserMessageId:
                          modeledBatchRetryRootUserMessageId,
                      }
                    : {}),
                  ...(resumesDurableModeledBatch
                    ? {
                        continuation:
                          activeModeledBatchContinuation ?? undefined,
                      }
                    : {}),
                };
              }
              send(controller, "error", {
                message: ev.message,
                code: ev.code,
                recovery: ev.recovery,
              });
              break;
          }
        },
        persistFailure: async (e) => {
          // Thrown mid-stream (incl. client abort): persist the partial so the
          // turn isn't lost. Outcome-invariant failures are different: any
          // streamed draft-shaped text is untrusted and must be discarded,
          // otherwise a rejected artifact could survive as plain chat content.
          const persistedFailureText = persistedFailureContent(e, streamedText);
          await persistAssistant(
            persistedFailureText,
            null,
            signal.aborted ? "cancelled" : "error",
          ).catch(() => {});
          const err = e as Error & { code?: string | number };
          send(controller, "error", { message: err.message, code: err.code });
        },
        release: async () => {
          // Clear the live plan — the turn is over, so a returning client should
          // see the persisted result, not a stale (now-complete) checklist. AWAIT
          // it before releaseChatTurn so the clear lands before the next turn (which
          // can only claim after release) writes its first plan — otherwise a slow
          // clear could null a newer turn's live_plan. Never throws (see above).
          await persistLivePlan(null);
          // Release the exclusive turn claim now the turn is fully done (success,
          // error, or abort), so the next message on this chat can start at once
          // rather than waiting out the staleness window.
          await deps.releaseChatTurn(workspaceId, chatId, turnCostOperationKey);
        },
      }).catch((cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        send(controller, "error", { message: error.message });
        return { terminal: "failure" as const, error };
      });
      const persistenceFailed =
        outcome.error?.name === "AssistantPersistenceError";
      await coworkTelemetry.finishStaged(
        resolveTurnOutcome({
          terminal: outcome.terminal,
          staged: coworkTelemetry.stagedTerminalOutcome(),
          persistenceFailed,
          cancelled: signal.aborted,
        }),
        persistenceFailed,
      );
      stopHeartbeat();
      resolveTerminal(outcome);
      // Guard the close: if the client already disconnected the controller is
      // closed and calling close() again throws. Mark closed first so any
      // straggler send() also no-ops.
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime on disconnect — nothing to do.
        }
      }
    },
    // Client disconnected (tab closed, Stop aborted the fetch). Stop writing; the
    // agent loop's own abort path (via signal) handles halting + persistence.
    cancel() {
      closed = true;
      stopHeartbeat();
    },
  });

  return { stream, claimedTurnStartedAt, claimedUserMessageId, terminal };
}
