import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { OpportunityCard } from "@/app/(app)/dashboard/agent-inbox";
import type { AgentInboxIdea } from "@/lib/agent-inbox";

function idea(overrides: Partial<AgentInboxIdea> = {}): AgentInboxIdea {
  return {
    id: "idea-1",
    workspaceId: "test-workspace",
    lane: "proven",
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

  // A card is a pitch, not a report: collapsed it carries only what the triage
  // decision needs. These tests render the initial (collapsed) state, which is
  // exactly what a user sees before showing interest.
  test("a collapsed card shows only the headline and angle", () => {
    const html = renderCard({ idea: idea() });
    expect(html).toContain("Turn your strongest topic into a practical teardown");
    expect(html).toContain("A specific direction grounded in evidence.");
    expect(html).not.toContain("Draft started");
    expect(html).not.toContain("No strong fit today");
  });

  test("a collapsed card defers the dossier and the actions to the expand", () => {
    const html = renderCard({
      idea: idea({
        why: ["Reason one", "Reason two", "Reason three"],
        sourceUrl: "https://example.test/story",
      }),
    });
    // The argument for the idea belongs to the expanded state — showing it up
    // front is what made three cards fill a viewport.
    expect(html).not.toContain("Why this is worth your attention");
    expect(html).not.toContain("Reason one");
    expect(html).not.toContain("Read source");
    // Expanding is the signal of intent, so that is where actions live. Nine
    // buttons across a collapsed row of three is the clutter this removes.
    expect(html).not.toContain("Start draft");
    expect(html).not.toContain("Not today");
    // The card itself is the toggle, so triage is one click anywhere on it.
    expect(html).toContain('aria-expanded="false"');
  });

  test("the evidence-strength bar is gone from the card", () => {
    const html = renderCard({ idea: idea({ score: 0.94 }) });
    // Every card scored in the same 94-95% band, so the readout discriminated
    // nothing while costing a heading and a full-width bar. `score` still
    // orders the lane; it just no longer renders.
    expect(html).not.toContain("Evidence strength");
    expect(html).not.toContain("94%");
  });

  test("evidence chips stay out of the collapsed card", () => {
    const html = renderCard({
      idea: idea({
        evidence: [
          { kind: "news", label: "Story one", detail: "d" },
          { kind: "performance", label: "Signal two", detail: "d" },
          { kind: "knowledge", label: "Knowledge three", detail: "d" },
        ],
      }),
    });
    // Chips move into the expanded state with the rest of the dossier; the
    // no-"+N more" guarantee still holds once expanded (all chips render).
    expect(html).not.toMatch(/\+\d more</);
    expect(html).not.toContain("Posts");
  });
});
