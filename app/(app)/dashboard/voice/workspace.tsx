"use client";

import { useState } from "react";
import { VoiceManager, type VoiceRow } from "./manager";
import { PreferencesManager } from "./preferences";
import { FeedbackMemoryManager } from "./feedback-memory";
import type { ReviewableContentPreference } from "@/lib/preference-evidence";
import type { ContentFeedback } from "@/lib/content-feedback";

// Layout: on wide screens the page splits into two columns instead of one long
// vertical stack. The profile and writing mechanics stay on the left; durable
// preference and feedback rules stay in the right rail. Factual context from
// the interview lives in Knowledge.
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
  preferences: ReviewableContentPreference[];
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

      {/* Right rail — standing writing rules and learned taste. */}
      <aside className="min-w-0 space-y-4 lg:sticky lg:top-6">
        <PreferencesManager initial={preferences} />
        <FeedbackMemoryManager initial={feedback} />
      </aside>
    </div>
  );
}
