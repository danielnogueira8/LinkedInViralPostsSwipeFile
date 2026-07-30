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
    expect(html).toContain("A fresh idea lands in this");
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

  test("an active idea renders the full card with its actions", () => {
    const html = renderCard({ idea: idea() });
    expect(html).toContain("Start draft");
    expect(html).not.toContain("Draft started");
    expect(html).not.toContain("No strong fit today");
  });

  test("long cards collapse to two reasons behind a View more toggle", () => {
    const html = renderCard({
      idea: idea({
        why: ["Reason one", "Reason two", "Reason three hidden until expanded"],
      }),
    });
    expect(html).toContain("Reason one");
    expect(html).toContain("Reason two");
    expect(html).not.toContain("Reason three hidden until expanded");
    expect(html).toContain("View more");
  });

  test("every evidence entry renders a chip (no +N more collapse)", () => {
    const html = renderCard({
      idea: idea({
        evidence: [
          { kind: "news", label: "Story one", detail: "d" },
          { kind: "performance", label: "Signal two", detail: "d" },
          { kind: "knowledge", label: "Knowledge three", detail: "d" },
        ],
      }),
    });
    expect(html).not.toMatch(/\+\d more</);
    // Kind tags render once per chip, in document order.
    expect(html).toContain("News");
    expect(html).toContain("Posts");
    expect(html).toContain("Knowledge");
  });
});
