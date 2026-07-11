"use client";

import { useState } from "react";
import { VoiceManager, type VoiceRow } from "./manager";
import { VoiceInterviewCard } from "./voice-interview-card";
import { PreferencesManager } from "./preferences";
import { FeedbackMemoryManager } from "./feedback-memory";
import type { ContentPreference } from "@/lib/preferences";
import type { ContentFeedback } from "@/lib/content-feedback";

// The Voice page's client shell. It owns the single source of truth for the
// voice row so the source-of-voice column (profile + summary + exemplars) and
// the "teach it more" rail (Context Interview) stay in sync when either mutates
// the profile — the interview can write interview_context back onto the same row
// the profile editor reads.
//
// Layout: on wide screens the page splits into two columns instead of one long
// vertical stack. Left is where the voice is *sourced and edited*; the right
// rail is where the user *teaches it more* — interview first (highest-leverage,
// most likely to be untouched), then the standing memory rules, then the softer
// taste feedback. On narrow screens it collapses back to a single column with
// the same reading order.
export function VoiceWorkspace({
  initialRow,
  canRegenerate,
  regenAvailableAt,
  daysUntilRegen,
  preferences,
  feedback,
}: {
  initialRow: VoiceRow | null;
  canRegenerate: boolean;
  regenAvailableAt: string | null;
  daysUntilRegen: number;
  preferences: ContentPreference[];
  feedback: ContentFeedback[];
}) {
  const [row, setRow] = useState<VoiceRow | null>(initialRow);

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
      {/* Left — source & edit the voice. */}
      <div className="min-w-0 space-y-4">
        <VoiceManager
          row={row}
          setRow={setRow}
          canRegenerate={canRegenerate}
          regenAvailableAt={regenAvailableAt}
          daysUntilRegen={daysUntilRegen}
        />
      </div>

      {/* Right rail — teach it more. Sticky on wide screens so it stays with
          the profile as the left column grows. */}
      <aside className="min-w-0 space-y-4 lg:sticky lg:top-6">
        <VoiceInterviewCard row={row} onSaved={setRow} />
        <PreferencesManager initial={preferences} />
        <FeedbackMemoryManager initial={feedback} />
      </aside>
    </div>
  );
}
