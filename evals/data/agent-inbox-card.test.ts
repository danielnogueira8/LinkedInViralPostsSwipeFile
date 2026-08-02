import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  agentLaneEmptyState,
  OpportunityCard,
} from "@/app/(app)/dashboard/agent-inbox";
import type { CurrentAgentInboxIdea } from "@/lib/agent-inbox";
import type { AgentFeedLane } from "@/lib/agent-inbox";

function idea(
  overrides: Partial<CurrentAgentInboxIdea> = {},
): CurrentAgentInboxIdea {
  return {
    id: "idea-1",
    workspaceId: "test-workspace",
    lane: "educational",
    status: "active",
    headline: "Turn your strongest topic into a practical teardown",
    angle: "A specific direction grounded in evidence.",
    why: ["It matches an active audience concern"],
    evidence: [],
    sourceKind: "workspace_learning",
    sourceRef: null,
    sourceUrl: null,
    sourceTitle: null,
    sourcePublishedAt: null,
    score: 0.9,
    fingerprint: "fingerprint-1",
    availableOn: "2026-07-30",
    expiresAt: null,
    snoozedUntil: null,
    actedAt: null,
    discardReason: null,
    readAt: null,
    createdAt: "2026-07-30T08:00:00Z",
    updatedAt: "2026-07-30T08:00:00Z",
    ...overrides,
  };
}

function renderCard(props: {
  idea?: CurrentAgentInboxIdea;
  acted?: CurrentAgentInboxIdea;
  snoozed?: CurrentAgentInboxIdea;
  lane?: AgentFeedLane;
}): string {
  return renderToStaticMarkup(
    createElement(OpportunityCard, {
      busy: false,
      onAction: () => {},
      onOpenDetails: () => {},
      ...props,
    }),
  );
}

describe("OpportunityCard lane states", () => {
  test("an acted idea shows a draft-started state, not the empty-lane copy", () => {
    const html = renderCard({
      acted: idea({ status: "acted", actedAt: "2026-07-30T09:00:00Z" }),
    });
    expect(html).toContain("Done");
    expect(html).toContain("Turn your strongest topic into a practical teardown");
    expect(html).not.toContain("No strong fit today");
    // No actions on a lane whose idea was already taken.
    expect(html).not.toContain("Start draft");
  });

  test("legacy snoozed activity does not expose a snooze decision", () => {
    const html = renderCard({
      snoozed: idea({
        status: "snoozed",
        snoozedUntil: "2026-07-31T08:00:00Z",
      }),
    });
    expect(html).not.toContain("Back tomorrow");
    expect(html).not.toContain("Not today");
    expect(html).not.toContain("Snooze");
    expect(html).toContain("No expertise angle is ready yet");
    expect(html).toContain("proven or approved to teach");
    expect(html).not.toContain("New ideas arrive every day");
  });

  test.each([
    ["personal_story", "No personal story is ready yet", "verified lived experience"],
    ["educational", "No expertise angle is ready yet", "proven or approved to teach"],
    ["trend_radar", "No trend signal is ready yet", "recent creator evidence"],
    ["newsjacking", "No news angle is ready yet", "verified event"],
  ] as const)(
    "an empty %s lane explains the evidence it still needs",
    (lane, title, description) => {
      const html = renderCard({ lane });
      expect(html).toContain(title);
      expect(html).toContain(description);
      expect(html).not.toContain("New ideas arrive every day");
    },
  );

  test("the all-agents empty state explains that recommendations must qualify", () => {
    expect(agentLaneEmptyState("all")).toEqual({
      title: "No recommendation cleared quality today",
      description:
        "Your agents only show ideas with enough evidence, relevance, and a defensible angle. They will keep looking as new signals arrive.",
    });
  });

  test("a card shows only the decision-critical summary", () => {
    const html = renderCard({ idea: idea() });
    expect(html).toContain("Turn your strongest topic into a practical teardown");
    expect(html).toContain("A specific direction grounded in evidence.");
    expect(html).toContain("Expertise");
    expect(html).toContain("Details");
    expect(html).toContain("/agents/bulk-writer.svg");
    expect(html).not.toContain("Why it fits you");
    expect(html).toContain("Open in Cowork");
    expect(html).toContain("Discard");
    expect(html).not.toContain("Not today");
    expect(html).not.toContain("Draft started");
    expect(html).not.toContain("No strong fit today");
  });

  test("a card keeps actions while moving rationale out of the summary", () => {
    const html = renderCard({
      idea: idea({
        why: ["Reason one", "Reason two", "Reason three"],
        sourceUrl: "https://example.test/story",
      }),
    });
    expect(html).not.toContain("Why it fits you");
    expect(html).not.toContain("Reason one");
    expect(html).toContain("Open in Cowork");
    expect(html).toContain("Discard");
    expect(html).not.toContain("Not today");
    expect(html).not.toContain("Why this is worth your attention");
    expect(html).not.toContain("Start draft");
  });

  test("the evidence-strength bar is gone from the card", () => {
    const html = renderCard({ idea: idea({ score: 0.94 }) });
    // Every card scored in the same 94-95% band, so the readout discriminated
    // nothing while costing a heading and a full-width bar. `score` still
    // orders the lane; it just no longer renders.
    expect(html).not.toContain("Evidence strength");
    expect(html).not.toContain("94%");
  });

  test("the card shows only an evidence count and leaves the dossier to details", () => {
    const html = renderCard({
      idea: idea({
        evidence: [
          { kind: "news", label: "Story one", detail: "d" },
          { kind: "performance", label: "Signal two", detail: "d" },
          { kind: "knowledge", label: "Knowledge three", detail: "d" },
        ],
      }),
    });
    expect(html).toContain("3 sources");
    expect(html).not.toContain("Story one");
    expect(html).not.toContain("Signal two");
    expect(html).not.toContain("+1 more");
    expect(html).not.toContain("Posts");
  });

  test("shows compact source provenance without expanding the card dossier", () => {
    const html = renderCard({
      idea: idea({
        evidence: [
          {
            kind: "source_post",
            role: "inspiration",
            label: "Alex's source post",
            authorName: "Alex Founder",
            detail: "A reusable teaching structure.",
            ref: "source-1",
            sourceOrigin: "swipe",
          },
          {
            kind: "knowledge",
            role: "anchor",
            subtype: "proof",
            label: "Verified customer proof",
            detail: "A result from this workspace.",
            ref: "knowledge-1",
          },
        ],
      }),
    });
    expect(html).toContain("Modeled from Alex Founder");
    expect(html).toContain("Grounded in Verified customer proof");
    expect(html).not.toContain("A reusable teaching structure.");
  });
});
