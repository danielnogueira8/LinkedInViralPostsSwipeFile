import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { OpportunityCard } from "@/app/(app)/dashboard/agent-inbox";
import type { AgentInboxIdea } from "@/lib/agent-inbox";

function idea(overrides: Partial<AgentInboxIdea> = {}): AgentInboxIdea {
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
    createdAt: "2026-07-30T08:00:00Z",
    updatedAt: "2026-07-30T08:00:00Z",
    ...overrides,
  };
}

function renderCard(props: {
  idea?: AgentInboxIdea;
  acted?: AgentInboxIdea;
  snoozed?: AgentInboxIdea;
}): string {
  return renderToStaticMarkup(
    createElement(OpportunityCard, {
      busy: false,
      onAction: () => {},
      ...props,
    }),
  );
}

describe("OpportunityCard lane states", () => {
  test("an acted idea shows a draft-started state, not the empty-lane copy", () => {
    const html = renderCard({
      acted: idea({ status: "acted", actedAt: "2026-07-30T09:00:00Z" }),
    });
    expect(html).toContain("Draft started");
    expect(html).toContain("Turn your strongest topic into a practical teardown");
    expect(html).not.toContain("No strong fit today");
    // No actions on a lane whose idea was already taken.
    expect(html).not.toContain("Start draft");
  });

  test("a snoozed idea still shows the back-tomorrow state", () => {
    const html = renderCard({
      snoozed: idea({
        status: "snoozed",
        snoozedUntil: "2026-07-31T08:00:00Z",
      }),
    });
    expect(html).toContain("Back tomorrow");
    expect(html).not.toContain("Draft started");
    expect(html).not.toContain("No strong fit today");
  });

  test("a genuinely empty lane keeps the no-strong-fit copy", () => {
    const html = renderCard({});
    expect(html).toContain("No strong fit today");
    expect(html).not.toContain("Draft started");
  });

  test("a card shows the lane, headline, angle, and approval context", () => {
    const html = renderCard({ idea: idea() });
    expect(html).toContain("Turn your strongest topic into a practical teardown");
    expect(html).toContain("A specific direction grounded in evidence.");
    expect(html).toContain("Expertise");
    expect(html).toContain("Why it fits you");
    expect(html).toContain("Use this idea");
    expect(html).not.toContain("Draft started");
    expect(html).not.toContain("No strong fit today");
  });

  test("a card keeps the primary decision in the queue", () => {
    const html = renderCard({
      idea: idea({
        why: ["Reason one", "Reason two", "Reason three"],
        sourceUrl: "https://example.test/story",
      }),
    });
    expect(html).toContain("Why it fits you");
    expect(html).toContain("Reason one");
    expect(html).toContain("Use this idea");
    expect(html).toContain("Not today");
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

  test("the card previews evidence and leaves the full dossier to details", () => {
    const html = renderCard({
      idea: idea({
        evidence: [
          { kind: "news", label: "Story one", detail: "d" },
          { kind: "performance", label: "Signal two", detail: "d" },
          { kind: "knowledge", label: "Knowledge three", detail: "d" },
        ],
      }),
    });
    expect(html).toContain("Story one");
    expect(html).toContain("Signal two");
    expect(html).toContain("+1 more");
    expect(html).not.toContain("Posts");
  });
});
