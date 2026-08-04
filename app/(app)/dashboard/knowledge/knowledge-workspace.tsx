"use client";

import { useState } from "react";
import type { WorkspaceKnowledgeItem } from "@/lib/content-learning/contracts";
import type { KnowledgeSourceSummary } from "@/lib/knowledge-sources/types";
import type { VoiceRow } from "../voice/manager";
import { ContextInterviewCard } from "./context-interview-card";
import { InterviewKnowledgeReview } from "./interview-knowledge-review";
import { KnowledgeLibrary } from "./workspace";
import { PreferencesManager } from "../voice/preferences";
import { FeedbackMemoryManager } from "../voice/feedback-memory";
import type { ReviewableContentPreference } from "@/lib/preference-evidence";
import type { ContentFeedback } from "@/lib/content-feedback";

type Props = {
  initialSources: KnowledgeSourceSummary[];
  available: boolean;
  extractionAvailable: boolean;
  retryAvailable: boolean;
  initialVoice: VoiceRow | null;
  knowledgeProposals: WorkspaceKnowledgeItem[];
  verifiedKnowledge: WorkspaceKnowledgeItem[];
  preferences: ReviewableContentPreference[];
  feedback: ContentFeedback[];
};

/** One heading treatment for every section, so five blocks read as a page. */
function SectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <h2 id={id} className="font-semibold">
        {title}
      </h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

// Keep all durable context in one client boundary. Saving the interview updates
// both its synthesized summary and its reviewable knowledge without a reload.
export function KnowledgeWorkspace({
  initialSources,
  available,
  extractionAvailable,
  retryAvailable,
  initialVoice,
  knowledgeProposals,
  verifiedKnowledge,
  preferences,
  feedback,
}: Props) {
  const [voice, setVoice] = useState(initialVoice);
  const [proposals, setProposals] = useState(knowledgeProposals);
  const [verified, setVerified] = useState(verifiedKnowledge);

  return (
    // Three sections, not five stacked cards: the page now holds the
    // interview, its review queue, standing rules, learned taste, and the
    // source library. Grouping by WHAT EACH ONE TEACHES keeps that scannable —
    // who you are, how you want to be written for, what Cowork can draw from.
    <div className="space-y-8">
      <section
        aria-labelledby="knowledge-interview-heading"
        className="space-y-3"
      >
        <SectionHeading
          id="knowledge-interview-heading"
          title="Teach Cowork about you"
          description="Turn your stories, beliefs, audience, and proof into private, reusable context."
        />
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <ContextInterviewCard
            row={voice}
            onSaved={setVoice}
            onKnowledgeSaved={(items) => {
              setProposals(
                items.filter((item) => item.verification === "proposed"),
              );
              setVerified(
                items.filter((item) => item.verification === "verified"),
              );
            }}
          />
          <InterviewKnowledgeReview
            proposals={proposals}
            verified={verified}
            onProposalsChange={setProposals}
            onVerifiedChange={setVerified}
          />
        </div>
      </section>

      <section
        aria-labelledby="knowledge-rules-heading"
        className="space-y-3"
      >
        <SectionHeading
          id="knowledge-rules-heading"
          title="How Cowork should write for you"
          description="Standing rules you set, and the taste it has learned from your feedback on drafts."
        />
        {/* Two independent lists, side by side on wide screens so neither
            becomes a long scroll and the relationship between them is
            visible: what you told it, and what it inferred. */}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <PreferencesManager initial={preferences} />
          <FeedbackMemoryManager initial={feedback} />
        </div>
      </section>

      <section
        aria-labelledby="knowledge-library-heading"
        className="space-y-3"
      >
        <SectionHeading
          id="knowledge-library-heading"
          title="Sources Cowork can draw from"
          description="Notes, documents, and research kept private to your workspace."
        />
        <KnowledgeLibrary
          initialSources={initialSources}
          available={available}
          extractionAvailable={extractionAvailable}
          retryAvailable={retryAvailable}
        />
      </section>
    </div>
  );
}
