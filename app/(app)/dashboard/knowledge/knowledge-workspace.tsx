"use client";

import { useState } from "react";
import type { WorkspaceKnowledgeItem } from "@/lib/content-learning/contracts";
import type { KnowledgeSourceSummary } from "@/lib/knowledge-sources/types";
import type { VoiceRow } from "../voice/manager";
import { ContextInterviewCard } from "./context-interview-card";
import { InterviewKnowledgeReview } from "./interview-knowledge-review";
import { KnowledgeLibrary } from "./workspace";

type Props = {
  initialSources: KnowledgeSourceSummary[];
  available: boolean;
  extractionAvailable: boolean;
  retryAvailable: boolean;
  initialVoice: VoiceRow | null;
  knowledgeProposals: WorkspaceKnowledgeItem[];
  verifiedKnowledge: WorkspaceKnowledgeItem[];
};

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
}: Props) {
  const [voice, setVoice] = useState(initialVoice);
  const [proposals, setProposals] = useState(knowledgeProposals);
  const [verified, setVerified] = useState(verifiedKnowledge);

  return (
    <div className="space-y-5">
      <section
        aria-labelledby="knowledge-interview-heading"
        className="space-y-3"
      >
        <div>
          <h2 id="knowledge-interview-heading" className="font-semibold">
            Teach Cowork about you
          </h2>
          <p className="text-sm text-muted-foreground">
            Turn your stories, beliefs, audience, and proof into private,
            reusable context.
          </p>
        </div>
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

      <KnowledgeLibrary
        initialSources={initialSources}
        available={available}
        extractionAvailable={extractionAvailable}
        retryAvailable={retryAvailable}
      />
    </div>
  );
}
