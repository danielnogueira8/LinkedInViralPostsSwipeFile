"use client";

import { useState } from "react";
import {
  Archive,
  Check,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fetchJson } from "@/lib/api-fetch";
import type { WorkspaceKnowledgeItem } from "@/lib/content-learning/contracts";
import { workspaceKnowledgeDisplayText } from "@/lib/content-learning/workspace-knowledge-presentation";

const kindLabel: Record<WorkspaceKnowledgeItem["kind"], string> = {
  story: "Story",
  belief: "Belief",
  proof: "Proof",
  offer: "Offer",
  audience_insight: "Audience",
  topic_expertise: "Expertise",
  prohibition: "Never claim",
};

export function InterviewKnowledgeReview({
  proposals,
  verified,
  onProposalsChange,
  onVerifiedChange,
}: {
  proposals: WorkspaceKnowledgeItem[];
  verified: WorkspaceKnowledgeItem[];
  onProposalsChange: (items: WorkspaceKnowledgeItem[]) => void;
  onVerifiedChange: (items: WorkspaceKnowledgeItem[]) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showVerified, setShowVerified] = useState(false);

  async function mutate(
    item: WorkspaceKnowledgeItem,
    action: "approve" | "reject" | "archive",
  ) {
    if (busyId) return;
    setBusyId(item.id);
    try {
      const response = await fetchJson<{
        ok: boolean;
        item: WorkspaceKnowledgeItem;
        error?: string;
      }>(`/api/voice/knowledge/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          expectedUpdatedAt: item.updatedAt,
        }),
      });
      if (!response.ok) {
        throw new Error(response.error || "Couldn't update this item.");
      }
      if (action === "approve") {
        onProposalsChange(
          proposals.filter((candidate) => candidate.id !== item.id),
        );
        onVerifiedChange([
          response.item,
          ...verified.filter((candidate) => candidate.id !== item.id),
        ]);
        toast.success("Approved as verified knowledge.");
      } else if (action === "reject") {
        onProposalsChange(
          proposals.filter((candidate) => candidate.id !== item.id),
        );
        toast.success("Dismissed.");
      } else {
        onVerifiedChange(
          verified.filter((candidate) => candidate.id !== item.id),
        );
        toast.success("Removed from Cowork's verified knowledge.");
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="border-border/70 bg-card/90 shadow-soft">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base">Knowledge for Cowork</CardTitle>
            <CardDescription>
              Review personal facts extracted from your answers before they
              become verified knowledge.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {proposals.length > 0 ? (
          <section aria-label="Knowledge awaiting review" className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Needs your review
              </h3>
              <Badge variant="secondary">{proposals.length}</Badge>
            </div>
            {proposals.map((item) => (
              <article
                key={item.id}
                className="space-y-2.5 rounded-xl border border-border/70 bg-muted/20 p-3"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{kindLabel[item.kind]}</Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {item.sourceRef?.includes(":chat-interview:")
                      ? "From an Interview me chat"
                      : "From your Context interview"}
                  </span>
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {item.title}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {workspaceKnowledgeDisplayText(item)}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId !== null}
                    aria-label={`Dismiss ${item.title}`}
                    onClick={() => mutate(item, "reject")}
                  >
                    {busyId === item.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    disabled={busyId !== null}
                    aria-label={`Approve ${item.title}`}
                    onClick={() => mutate(item, "approve")}
                  >
                    {busyId === item.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    Approve
                  </Button>
                </div>
              </article>
            ))}
          </section>
        ) : (
          <div className="rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
            No personal facts are waiting for review.
          </div>
        )}

        {verified.length > 0 ? (
          <section aria-label="Verified knowledge" className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Approved
              </h3>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showVerified}
                aria-controls="verified-knowledge-items"
                onClick={() => setShowVerified((current) => !current)}
              >
                {showVerified
                  ? "Hide approved"
                  : `Show approved (${verified.length})`}
              </Button>
            </div>
            <div
              id="verified-knowledge-items"
              hidden={!showVerified}
              className="space-y-2.5"
            >
              {showVerified
                ? verified.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-start justify-between gap-3 rounded-xl border border-state-success-border bg-state-success/[0.04] p-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          <Check className="h-3.5 w-3.5 shrink-0 text-state-success" />
                          {item.title}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {workspaceKnowledgeDisplayText(item)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busyId !== null}
                        aria-label={`Remove ${item.title}`}
                        onClick={() => mutate(item, "archive")}
                      >
                        {busyId === item.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Archive className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  ))
                : null}
            </div>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
