import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { NoWorkspaceError } from "@/lib/workspace";
import {
  runAgent,
  stripArtifactFences,
  windowChatHistory,
  type Artifact,
} from "@/lib/agent/run";
import {
  checkChatRateLimit,
  claimChatTurn,
  releaseChatTurn,
} from "@/lib/agent/rate-limit";
import { neutralizeMarkers, safeFilename } from "@/lib/agent/untrusted";
import { SKILLS_PER_TURN_MAX, SKILL_BODY_MAX } from "@/lib/custom-skills";
import type { ChatMessage, ContentBlock, ToolCall } from "@/lib/openrouter";

export const runtime = "nodejs";
// The agent loop can run several tool rounds + a long final generation. Give it
// the same generous ceiling as the voice route (Vercel Pro fluid compute).
export const maxDuration = 300;

// Attachment limits. GLM-5.1 is text-only: 'text' attachments are inlined as a
// delimited reference; 'file' attachments (PDF/doc) ride as a file content
// block that OpenRouter parses to text. Images/video are rejected in the UI.
const MAX_ATTACHMENTS = 5;
// ~10MB per file as a base64 data URL (base64 is ~1.33x the raw bytes).
const MAX_DATA_URL_LEN = 14_000_000;
const MAX_TEXT_LEN = 200_000; // inlined text-file cap (chars)
// Aggregate cap across all attachments in one request (~28MB of base64 ≈ 20MB
// raw), so a request body can't balloon into memory regardless of the per-file
// caps. The client enforces a friendlier 20MB; this is the hard backstop.
const MAX_TOTAL_ATTACHMENT_LEN = 28_000_000;

const attachmentSchema = z.object({
  kind: z.enum(["text", "file"]),
  filename: z.string().min(1).max(255),
  // For kind:'text' — the decoded text content (client reads it).
  text: z.string().max(MAX_TEXT_LEN).optional(),
  // For kind:'file' — a data: URL (e.g. data:application/pdf;base64,...).
  dataUrl: z.string().max(MAX_DATA_URL_LEN).optional(),
});

const bodySchema = z.object({
  message: z.string().trim().min(1).max(8000),
  // "Model this post": the stashed source id (chat_modeling_sources). The server
  // fetches + weaves the post text, so a long post never hits the message cap.
  modelSourceId: z.string().uuid().optional(),
  // True for an AI-refine turn (the user clicked "Refine" on a specific draft).
  // A refine already targets ONE unambiguous card client-side, so the decision
  // pre-pass must NOT intercept it with a "which draft?" clarifying question —
  // that swallows the refine (no artifact → no in-place swap / version history).
  // The flag tells runAgent to skip the decision layer for this turn.
  skipDecision: z.boolean().optional(),
  // Custom skills the user invoked this turn (via /name or the ⚡ picker). The
  // server resolves these ids → bodies (workspace-scoped, capped) and injects
  // them into the agent's skill block. Capped here too so a crafted request
  // can't smuggle in dozens.
  skillIds: z.array(z.string().uuid()).max(SKILLS_PER_TURN_MAX).optional(),
  attachments: z
    .array(attachmentSchema)
    .max(MAX_ATTACHMENTS)
    .optional()
    .refine(
      (atts) =>
        !atts ||
        atts.reduce(
          (n, a) => n + (a.dataUrl?.length ?? 0) + (a.text?.length ?? 0),
          0,
        ) <= MAX_TOTAL_ATTACHMENT_LEN,
      { message: "Attachments exceed the total size limit." },
    ),
});

type Attachment = z.infer<typeof attachmentSchema>;

type DbMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
};

// -----------------------------------------------------------------------------
// POST /api/chats/[id]/stream
//
// Body: { message }. Persists the user message, runs the GLM-5.1 agent over the
// full transcript, and streams AgentEvents back as SSE. On completion persists
// the assistant turn (text + tool_calls + artifacts) and every tool result, and
// bumps the chat's updated_at (+ auto-titles it from the first user message).
// -----------------------------------------------------------------------------
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: chatId } = await params;

  // Resolve workspace + validate the chat up front (outside the stream) so auth
  // / not-found errors come back as normal JSON, not a half-open SSE stream.
  let workspaceId: string;
  let sbRaw: Awaited<ReturnType<typeof scopedSupabase>>["raw"];
  let userText: string;
  let attachments: Attachment[] = [];
  let modelSourceId: string | undefined;
  let skipDecision = false;
  let skillIds: string[] = [];
  // Resolved bodies of the user's invoked custom skills (filled in below).
  let customSkillBodies: string[] = [];
  // Parallel to customSkillBodies — the slugs, passed to the decide pre-pass so
  // it never asks "which skill?" when one is already applied (see decide.ts).
  let customSkillNames: string[] = [];
  // Set once claimChatTurn succeeds, so any later failure in setup (or the
  // stream's finally) releases the exclusive turn claim rather than leaving the
  // chat wedged until the staleness window expires.
  let turnClaimed = false;
  try {
    const sb = await scopedSupabase();
    workspaceId = sb.workspaceId;
    sbRaw = sb.raw;
    const body = bodySchema.parse(await req.json());
    userText = body.message;
    attachments = body.attachments ?? [];
    modelSourceId = body.modelSourceId;
    skipDecision = body.skipDecision ?? false;
    skillIds = body.skillIds ?? [];

    const { data: chat, error } = await sbRaw
      .from("chats")
      .select("id, title")
      .eq("id", chatId)
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!chat) {
      return jsonError("Chat not found", 404);
    }

    // Monthly cost cap first (fail-closed money ceiling). The hourly/daily count
    // caps + the user-message insert happen atomically in claimChatTurn below.
    const cost = await checkChatRateLimit(workspaceId);
    if (!cost.ok) {
      logChatReject(workspaceId, chatId, cost.reason ?? "cost_cap", 429);
      return jsonError(
        cost.message,
        429,
        cost.retryAfterSec ? { "Retry-After": String(cost.retryAfterSec) } : undefined,
      );
    }

    const fileNote = attachments.length
      ? `\n\n📎 Attached: ${attachments.map((a) => safeFilename(a.filename)).join(", ")}`
      : "";
    const turnContent = userText + fileNote;

    // Duplicate-turn guard — the AUTHORITATIVE spend protection. The client
    // has an in-flight lock, but a rapid double-submit (observed: the same
    // prompt POSTed 5-7x within ~140ms-3s, each one a full billed agent turn)
    // can race past it before a run registers. So we ALSO reject duplicates
    // server-side, where it actually protects credits regardless of the client.
    //
    // Reject when the most recent message in this chat is EITHER:
    //   (a) a user row with identical content — a prior identical send whose
    //       turn hasn't produced its assistant reply yet (the burst case), or
    //   (b) any user row newer than ~10s ago — a turn is mid-flight (the
    //       assistant row lands only when the agent finishes), so a fresh POST
    //       now is a resubmit, not a real follow-up.
    // Neither inserts a row nor runs the agent → no spend.
    const { data: lastMsg } = await sbRaw
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("chat_id", chatId)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastMsg?.role === "user") {
      const ageMs = Date.now() - new Date(lastMsg.created_at as string).getTime();
      const sameContent = (lastMsg.content as string) === turnContent;
      // 10s window covers a normal turn's latency. Skew-tolerant (>= 0): a
      // brand-new row reads as ~0ms old; a stale clock can't make it negative
      // enough to slip a real duplicate through (see [[feedback-vercel-clock-skew]]).
      if (sameContent || (ageMs >= 0 && ageMs < 10_000)) {
        logChatReject(workspaceId, chatId, "duplicate_turn", 409);
        return jsonError(
          "That message is already being processed — please wait for the reply before sending again.",
          409,
        );
      }
    }

    // Atomically check the count caps AND persist the user message in one
    // locked transaction, so concurrent requests can't all slip past the caps.
    // We store the typed text + a compact note of attached filenames (not the
    // file bytes — those are consumed this turn only).
    const claim = await claimChatTurn(workspaceId, chatId, turnContent);
    if (!claim.ok) {
      // turn_active is a concurrency conflict (409), not a rate limit (429).
      const status = claim.reason === "turn_active" ? 409 : 429;
      logChatReject(workspaceId, chatId, claim.reason ?? "claim_failed", status);
      return jsonError(
        claim.message,
        status,
        claim.retryAfterSec ? { "Retry-After": String(claim.retryAfterSec) } : undefined,
      );
    }
    // The exclusive turn claim is now held; ensure it's released on every exit.
    turnClaimed = true;

    // Auto-title from the first user message if still the default. The
    // `.eq("title", "New chat")` makes this atomic: it only titles when the DB
    // row is STILL the default, so a concurrent user rename is never clobbered
    // (the stale in-memory chat.title is just a cheap pre-check).
    if (chat.title === "New chat") {
      const title = userText.replace(/\s+/g, " ").slice(0, 60).trim();
      if (title) {
        await sbRaw
          .from("chats")
          .update({ title, updated_at: new Date().toISOString() })
          .eq("id", chatId)
          .eq("workspace_id", workspaceId)
          .eq("title", "New chat");
      }
    }

    // Clear any stale cancel flag from a prior turn so the loop's between-
    // rounds polling can't accidentally cancel THIS turn based on a leftover
    // timestamp. The agent loop polls cancel_requested_at > turnStartedAt.
    await sbRaw
      .from("chats")
      .update({ cancel_requested_at: null })
      .eq("id", chatId)
      .eq("workspace_id", workspaceId);
  } catch (e) {
    // If we'd already claimed the turn before failing, release it so the chat
    // isn't wedged until the staleness window (workspaceId/sbRaw are set by then).
    if (turnClaimed) await releaseChatTurn(workspaceId!, chatId);
    if (e instanceof NoWorkspaceError) return jsonError(e.message, 400);
    if (e instanceof z.ZodError) return jsonError("Invalid request body", 400);
    return jsonError((e as Error)?.message ?? "Unexpected error", 500);
  }

  // Everything from here to the stream runs AFTER the turn claim has inserted
  // the user message. A throw in this span (a DB connection drop on the history
  // read, the model-source fetch, or the skill resolution) used to escape
  // UNCAUGHT — the claim stayed held (chat wedged ~330s) AND the user row sat
  // with no assistant reply (dangling turn). Wrap it: on a throw we release the
  // claim, persist a brief error reply so the user row isn't orphaned, and
  // return a clean JSON error. (The ReadableStream has its OWN try/finally for
  // throws DURING streaming.)
  let history: ChatMessage[];
  let blocks: ContentBlock[];
  try {
  // Load prior transcript (excluding the message we just inserted is fine —
  // include it; it's the latest user turn the agent should answer).
  // Fetch the MOST RECENT rows (desc + limit), then flip to chronological.
  // windowChatHistory trims to the last ~20 user turns anyway; a 300-row cap is
  // a defensive backstop so we never pull an enormous transcript into memory on
  // a pathologically long chat. 300 rows comfortably exceeds 20 turns' worth of
  // user+assistant+tool messages, so the window is applied to a complete recent
  // slice, never a mid-turn truncation of the fetch.
  const { data: rowsDesc } = await sbRaw
    .from("chat_messages")
    .select("role, content, tool_calls, tool_call_id")
    .eq("chat_id", chatId)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(300);
  const rows = (rowsDesc ?? []).slice().reverse();

  history = ((rows ?? []) as DbMessage[]).map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  }));
  // Cap the transcript sent to the model so a long-lived chat can't grow its
  // context unbounded (eventually exceeding the model's window with no user
  // recovery, and burning cost meanwhile). Trims on a user-turn boundary so
  // assistant+tool groups stay well-formed. The latest user turn — the one being
  // answered, and where blocks are woven below — is always kept.
  history = windowChatHistory(history);

  // Weave the "Model this post" source + this turn's files into the final user
  // message the agent sees. The persisted user row stays clean (just the typed
  // text + a filename note) — this rich content is consumed in-flight only, so
  // a long modeled post never hits the 8000-char message cap and a reloaded
  // transcript never shows the raw delimiter blob.
  blocks = [{ type: "text", text: userText }];

  if (modelSourceId) {
    const { data: src } = await sbRaw
      .from("chat_modeling_sources")
      .select("post_text, source")
      .eq("id", modelSourceId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const postText = (src?.post_text as string | null)?.trim();
    if (postText) {
      // The envelope framing depends on provenance, so the agent (see
      // lib/agent/run.ts) knows what the attached text IS:
      //   - 'draft'    → the user's OWN post to REFINE in place.
      //   - 'template' → a fill-in-the-blank SKELETON with {placeholders} to
      //                  turn into a real post (NOT a post to model after, NOT
      //                  a post to reproduce — fill the blanks in the user's
      //                  voice and topic, keeping the structure/rhythm).
      //   - swipe/bookmark → a reference post to model a NEW post AFTER.
      // Neutralized at stash time; neutralize again (idempotent) so the envelope
      // is safe even if the row predates that fix.
      const clean = neutralizeMarkers(postText);
      let text: string;
      if (src?.source === "draft") {
        text = `\n\n--- POST TO REFINE ---\n${clean}\n--- END POST ---`;
      } else if (src?.source === "template") {
        text = `\n\n--- TEMPLATE TO FILL ---\n${clean}\n--- END TEMPLATE ---`;
      } else {
        text = `\n\n--- POST TO MODEL AFTER ---\n${clean}\n--- END POST ---`;
      }
      blocks.push({ type: "text", text });
    }
  }

  for (const a of attachments) {
    if (a.kind === "text" && a.text) {
      // Inline text files as a delimited reference the agent treats as data.
      // Untrusted: neutralize forged markers in the body, sanitize the filename.
      blocks.push({
        type: "text",
        text: `\n\n--- ATTACHED FILE: ${safeFilename(a.filename)} ---\n${neutralizeMarkers(a.text)}\n--- END FILE ---`,
      });
    } else if (a.kind === "file" && a.dataUrl) {
      blocks.push({
        type: "file",
        file: { filename: a.filename, file_data: a.dataUrl },
      });
    }
  }

  // Resolve the invoked custom skills → their bodies (workspace-scoped, so a
  // crafted skillId from another tenant resolves to nothing; RLS + the explicit
  // workspace_id filter both enforce it). Capped count (schema) + capped body
  // length here, so the injected skill block stays bounded regardless of the
  // stored data. Order-preserved to match what the user picked. These are passed
  // to runAgent separately (NOT woven into the user message) — they're agent
  // guidance, not content the user "said".
  if (skillIds.length) {
    const { data: skillRows } = await sbRaw
      .from("custom_skills")
      .select("id, name, body")
      .eq("workspace_id", workspaceId)
      .in("id", skillIds);
    type Row = { id: string; name: string; body: string };
    const byIdMap = new Map(
      (skillRows ?? []).map((r) => [r.id as string, r as Row]),
    );
    const resolved = skillIds
      .map((id) => byIdMap.get(id))
      .filter((r): r is Row =>
        !!r && typeof r.body === "string" && r.body.trim().length > 0,
      )
      .slice(0, SKILLS_PER_TURN_MAX);
    customSkillBodies = resolved.map((r) => r.body.slice(0, SKILL_BODY_MAX));
    customSkillNames = resolved.map((r) => r.name);

    // Stash the applied skill names on the just-inserted user row so the
    // hydrate can render a "/skill" badge on the user bubble after a reload
    // (without this, the bubble loses any trace that a skill was applied
    // once the composer chip is consumed on send). Stored as a synthetic
    // entry in the `tool_calls` jsonb — the column was nullable + unused for
    // user rows, so no migration; the hydrate already iterates tool_calls
    // and matches by function.name. Best-effort: a failure here doesn't
    // affect the turn (the skill bodies are still injected into the prompt).
    if (customSkillNames.length > 0) {
      const { data: row } = await sbRaw
        .from("chat_messages")
        .select("id")
        .eq("chat_id", chatId)
        .eq("workspace_id", workspaceId)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (row?.id) {
        await sbRaw
          .from("chat_messages")
          .update({
            tool_calls: [
              {
                id: "_skills_applied",
                type: "function",
                function: {
                  name: "_custom_skills_applied",
                  arguments: JSON.stringify({ names: customSkillNames }),
                },
              },
            ],
          })
          .eq("id", row.id)
          .eq("workspace_id", workspaceId);
      }
    }
  }

  // Replace the last user turn with the rich content (only if we added anything
  // beyond the plain text).
  if (blocks.length > 1) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") {
        history[i] = { role: "user", content: blocks };
        break;
      }
    }
  }
  } catch (e) {
    // A throw in the post-claim setup span: release the claim (else the chat
    // wedges ~330s) + persist a short error reply so the just-inserted user
    // message isn't left dangling with no answer, then return JSON (no stream
    // was opened yet). Best-effort on both side effects.
    await releaseChatTurn(workspaceId, chatId).catch(() => {});
    await sbRaw
      .from("chat_messages")
      .insert({
        chat_id: chatId,
        workspace_id: workspaceId,
        role: "assistant",
        content: "⚠️ Something went wrong starting this turn. Please try again.",
      })
      .then(() => {})
      .then(undefined, () => {});
    return jsonError((e as Error)?.message ?? "Failed to start the turn", 500);
  }

  const encoder = new TextEncoder();
  // Once the client disconnects, the underlying controller is closed/errored and
  // enqueuing to it throws `Invalid state: Controller is already closed`. Guard
  // every write behind a `closed` flag (set in finally and on stream cancel) and
  // swallow any residual enqueue error, so a late event on a torn-down stream
  // can't throw out of `start` and skip persistence / double-close.
  let closed = false;
  const send = (
    controller: ReadableStreamDefaultController,
    event: string,
    data: unknown,
  ) => {
    if (closed) return;
    try {
      controller.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    } catch {
      // Controller already closed (client gone) — stop trying to write.
      closed = true;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const artifacts: Artifact[] = [];
      // Accumulate streamed text + whether we've already persisted the assistant
      // turn, so an error/abort mid-stream still saves a row (otherwise the user
      // message is orphaned with no reply, which corrupts the next turn's
      // history).
      let streamedText = "";
      let persisted = false;
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
        tokens?: { input: number; output: number },
        toolMessages?: { content: string; tool_call_id: string | null }[],
      ): Promise<boolean> => {
        if (persisted) return true;
        persisted = true;
        if (toolMessages?.length) {
          const { error: toolErr } = await sbRaw.from("chat_messages").insert(
            toolMessages.map((t) => ({
              chat_id: chatId,
              workspace_id: workspaceId,
              role: "tool" as const,
              content: t.content ?? "",
              tool_call_id: t.tool_call_id ?? null,
            })),
          );
          // A tool-row failure alone doesn't lose the reply, but it can leave
          // the assistant row referencing tool_call_ids with no matching tool
          // rows (malformed history next turn). Log it; still try the assistant
          // insert so the reply itself isn't lost too.
          if (toolErr) {
            console.error(
              JSON.stringify({
                assistant_persist_failed: {
                  stage: "tool_messages",
                  chat_id: chatId,
                  workspace_id: workspaceId,
                  error: toolErr.message,
                },
              }),
            );
          }
        }
        // Persist cite artifacts as a bare postId reference — drop the resolved
        // meta.card snapshot. Engagement counts drift and LinkedIn media URLs
        // expire (~weekly), so the card is RE-RESOLVED fresh on chat load
        // rather than stored stale. post/hook artifacts persist as-is.
        const persistArtifacts = artifacts.map((a) =>
          a.kind === "cite"
            ? { ...a, meta: { postId: (a.meta as { postId?: string })?.postId } }
            : a,
        );
        const { error: asstErr } = await sbRaw.from("chat_messages").insert({
          chat_id: chatId,
          workspace_id: workspaceId,
          role: "assistant",
          content,
          tool_calls: toolCalls,
          artifacts: persistArtifacts.length ? persistArtifacts : null,
          input_tokens: tokens?.input ?? null,
          output_tokens: tokens?.output ?? null,
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
      try {
        for await (const ev of runAgent({
          history,
          workspaceId,
          // chatId is what lets the loop poll chats.cancel_requested_at so the
          // Stop button (POST /api/chats/[id]/stop) actually halts the turn.
          chatId,
          signal: req.signal,
          // A refine turn already targets one draft — skip the clarify pre-pass.
          skipDecision,
          // skipDecision is set ONLY by an AI refine (the Refine button or a
          // composer-detected refine), so it doubles as the refine signal:
          // caps drafts at 1 for this turn so a "make it shorter" can't explode
          // into 6 fragment cards.
          isRefine: skipDecision,
          // Custom skills the user invoked this turn (resolved + capped above).
          customSkillBodies,
          customSkillNames,
        })) {
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
              // ordered step list (client replaces, doesn't merge). Transient —
              // not persisted with the message; on reload the finished turn just
              // shows its result, not the (now-complete) plan.
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
              send(controller, "preference_saved", { id: ev.id, rule: ev.rule });
              break;
            case "artifact": {
              // Stamp the active custom skills into the artifact's meta so the
              // draft card can show a /skill badge. cite artifacts are
              // passthrough references, not generated content — left untagged.
              // ONE decorate before push (persist) and send (live stream) so
              // both reload + streaming see the same badge.
              const tagged = tagArtifactWithSkills(ev.artifact, customSkillNames);
              artifacts.push(tagged);
              send(controller, "artifact", tagged);
              break;
            }
            case "done": {
              const saved = await persistAssistant(
                ev.message.content,
                ev.message.tool_calls,
                {
                  input: ev.message.inputTokens,
                  output: ev.message.outputTokens,
                },
                ev.message.toolMessages.map((t) => ({
                  // Tool messages always carry string content.
                  content: typeof t.content === "string" ? t.content : "",
                  tool_call_id: t.tool_call_id ?? null,
                })),
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
                break;
              }
              send(controller, "done", { artifacts });
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
                );
              }
              send(controller, "error", {
                message: ev.message,
                code: ev.code,
                recovery: ev.recovery,
              });
              break;
          }
        }
      } catch (e) {
        // Thrown mid-stream (incl. client abort): persist the partial so the
        // turn isn't lost, then surface the error (preserving any provider
        // error code so the client can render a specific message).
        await persistAssistant(
          stripArtifactFences(streamedText) ||
            "⚠️ The assistant hit an error and couldn't finish this response.",
          null,
        ).catch(() => {});
        const err = e as Error & { code?: string | number };
        send(controller, "error", { message: err.message, code: err.code });
      } finally {
        // Release the exclusive turn claim now the turn is fully done (success,
        // error, or abort), so the next message on this chat can start at once
        // rather than waiting out the staleness window.
        await releaseChatTurn(workspaceId, chatId);
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
      }
    },
    // Client disconnected (tab closed, Stop aborted the fetch). Stop writing; the
    // agent loop's own abort path (via req.signal) handles halting + persistence.
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function jsonError(
  message: string,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders ?? {}) },
  });
}

// Emit a structured log on a guarded turn rejection (duplicate-send, cost cap,
// count cap, concurrent turn). These are the paths that protect against the
// worst money incident (the duplicate-send burst), yet they were invisible:
// nothing was logged, so a client-guard regression would be undetectable in
// production without it recurring on a bill. The `chat_reject` envelope mirrors
// the `agent_turn` one in run.ts — grep `chat_reject AND reason:duplicate_turn`
// to see the dedupe firing, or `chat_reject AND status:429` for cap hits.
// Exported so the diagnostic contract (the exact log shape) is unit-tested
// rather than silently drifting.
export function chatRejectLogLine(
  workspaceId: string,
  chatId: string,
  reason: string,
  status: number,
): string {
  return JSON.stringify({
    chat_reject: { workspace_id: workspaceId, chat_id: chatId, reason, status },
  });
}

function logChatReject(
  workspaceId: string,
  chatId: string,
  reason: string,
  status: number,
): void {
  console.log(chatRejectLogLine(workspaceId, chatId, reason, status));
}

// Stamp the turn's active custom-skill slugs onto a generated artifact's meta
// so the draft card can show "produced with /name" chips. Pure — exported so
// the contract (cite is never tagged; existing meta keys are preserved; no
// skills → passthrough) is unit-tested.
export function tagArtifactWithSkills(
  artifact: Artifact,
  skillNames: string[],
): Artifact {
  if (skillNames.length === 0) return artifact;
  if (artifact.kind === "cite") return artifact;
  return {
    ...artifact,
    meta: { ...(artifact.meta ?? {}), skills: skillNames },
  };
}
