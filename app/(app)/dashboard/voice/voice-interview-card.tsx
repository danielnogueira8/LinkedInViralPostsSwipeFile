"use client";

import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, MessagesSquare, Check } from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import { INTERVIEW_QUESTIONS } from "@/lib/voice-interview";
import type { VoiceRow } from "./manager";
import type { WorkspaceKnowledgeItem } from "@/lib/content-learning/contracts";

// The context interview: a short set of ghostwriter-style questions the user
// answers to give the AI richer material. Answers are synthesized into the
// user's voice and stored as always-on drafting context (editable). Every
// question is skippable — a blank answer is simply dropped.
export function VoiceInterviewCard({
  row,
  onSaved,
  onKnowledgeSaved,
}: {
  row: VoiceRow | null;
  onSaved: (saved: VoiceRow) => void;
  onKnowledgeSaved: (items: WorkspaceKnowledgeItem[]) => void;
}) {
  const profile = row?.profile ?? null;
  // Seed the fields from any previously-saved answers (keyed by question text).
  const savedAnswers = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of profile?.interview_answers ?? []) map.set(a.question, a.answer);
    return map;
  }, [profile?.interview_answers]);

  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of INTERVIEW_QUESTIONS) init[q.id] = savedAnswers.get(q.prompt) ?? "";
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(
    () => (profile?.interview_context?.length ?? 0) === 0,
  );

  const context = profile?.interview_context ?? [];
  const answeredCount = Object.values(answers).filter((v) => v.trim()).length;

  async function submit() {
    if (busy) return;
    const payload = INTERVIEW_QUESTIONS.map((q) => ({
      question: q.prompt,
      answer: answers[q.id]?.trim() ?? "",
    })).filter((a) => a.answer);
    if (payload.length === 0) {
      toast.error("Answer at least one question first.");
      return;
    }
    setBusy(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        voice: VoiceRow;
        knowledge?: WorkspaceKnowledgeItem[];
        error?: string;
      }>(
        "/api/voice/interview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers: payload }),
        },
      );
      if (!data.ok) throw new Error(data.error || "Couldn't process the interview.");
      onSaved(data.voice);
      if (data.knowledge) onKnowledgeSaved(data.knowledge);
      // Only collapse into the read-only summary if there's actually a
      // summary to show — never collapse to a state with no form AND no
      // context (the server now throws on malformed/empty output instead of
      // returning a false "success", but this stays as defense-in-depth).
      const savedContext = data.voice?.profile?.interview_context ?? [];
      if (savedContext.length > 0) setExpanded(false);
      toast.success("Interview saved — your answers now shape every draft.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      aria-label="Context interview"
      className="overflow-hidden border-border/70 bg-card/90 shadow-soft lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto lg:overscroll-contain"
      data-testid="context-interview-scroll"
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
              <MessagesSquare className="h-4 w-4" />
            </div>
            <div className="min-w-0 space-y-1">
              <CardTitle className="text-base">Context interview</CardTitle>
              <CardDescription>
                The questions a top ghostwriter asks before writing for you. Your
                answers give the AI the real stories, beliefs, and proof it can&apos;t
                invent — so drafts sound like you, not a generic template. Every
                question is optional.
              </CardDescription>
            </div>
          </div>
          {/* Always reachable — even if a save somehow lands with empty
              context, the user must never be stuck looking at a bare header
              with no way back into the form. */}
          {!expanded ? (
            <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
              {context.length > 0 ? "Edit answers" : "Answer questions"}
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Synthesized context — what the AI now knows about you. Editable via
            the profile editor; shown here read-only as the interview result. */}
        {context.length > 0 && (
          <div className="rounded-xl border border-state-success-border bg-state-success/[0.05] p-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-state-success">
              <AiIcon className="h-3.5 w-3.5" />
              What the AI now writes from
            </div>
            <ul className="space-y-1.5">
              {context.map((c, i) => (
                <li key={i} className="flex gap-2 text-sm leading-snug text-foreground">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-state-success" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-xs text-muted-foreground">
              Edit these anytime in the profile editor above, or re-answer below.
            </p>
          </div>
        )}

        {expanded && (
          <div className="space-y-4">
            {/* The whole interview card scrolls as one surface on desktop,
                including the saved context above the questions. Compact
                layouts keep the page as their only scroll surface. */}
            <div
              aria-label="Interview questions"
              className="space-y-4"
              data-testid="interview-questions-scroll"
            >
              {INTERVIEW_QUESTIONS.map((q, i) => (
                <div key={q.id} className="space-y-1.5">
                  <label
                    htmlFor={`interview-${q.id}`}
                    className="block text-sm font-medium text-foreground"
                  >
                    <span className="mr-1.5 text-muted-foreground tabular-nums">{i + 1}.</span>
                    {q.prompt}
                  </label>
                  <p className="text-xs text-muted-foreground">{q.helper}</p>
                  <Textarea
                    id={`interview-${q.id}`}
                    rows={2}
                    placeholder={q.placeholder}
                    value={answers[q.id] ?? ""}
                    onChange={(e) =>
                      setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                    }
                    className="resize-y"
                  />
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="text-xs text-muted-foreground">
                {answeredCount} of {INTERVIEW_QUESTIONS.length} answered · skip any you like
              </span>
              <div className="flex items-center gap-2">
                {context.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
                    Cancel
                  </Button>
                )}
                <Button onClick={submit} disabled={busy || answeredCount === 0}>
                  {busy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Building your context…
                    </>
                  ) : context.length > 0 ? (
                    <>
                      <AiIcon className="h-4 w-4" /> Rebuild from answers
                    </>
                  ) : (
                    <>
                      <AiIcon className="h-4 w-4" /> Build my context
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
