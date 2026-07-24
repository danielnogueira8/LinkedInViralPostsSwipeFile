import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { ConfirmReadback } from "@/app/(app)/dashboard/confirm-readback";
import type { TurnDecision } from "@/lib/agent/turn/resolve-decision";

// Renders the read-back sheet to static HTML so its structure — summary,
// chips, amber conflict flags, and the Generate/Keep-editing controls — is
// verified, not just the pure helpers. The click callbacks are asserted by
// wiring, since static markup does not dispatch events.

function decision(overrides: Partial<TurnDecision> = {}): TurnDecision {
  return {
    mode: "ask",
    postCount: 5,
    niche: null,
    postType: null,
    hasModelSource: false,
    hasCreatorStyle: false,
    hasLeadMagnetSelection: false,
    taskKind: "ideas",
    conflicts: [],
    route: { readOnly: null, contractKind: "answer" },
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof ConfirmReadback>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ConfirmReadback, {
      decision: decision(),
      onGenerate: vi.fn(),
      onDismiss: vi.fn(),
      onFix: vi.fn(),
      ...props,
    }),
  );
}

describe("ConfirmReadback render", () => {
  test("renders the header, summary, and both action buttons", () => {
    const html = render();
    expect(html).toContain("Here");
    expect(html).toContain("Brainstorm");
    expect(html).toContain("Generate");
    expect(html).toContain("Keep editing");
  });

  test("renders a Mode chip and a Niche chip for an ideas turn", () => {
    const html = render({ decision: decision({ niche: null }) });
    expect(html).toContain("Mode");
    expect(html).toContain("Niche");
    expect(html).toContain("All niches");
  });

  test("shows the resolved niche when one is set", () => {
    const html = render({ decision: decision({ niche: "SaaS" }) });
    expect(html).toContain("SaaS");
  });

  test("renders a Source chip when a model source drives the turn", () => {
    const html = render({
      decision: decision({ mode: "create", taskKind: "post", hasModelSource: true }),
    });
    expect(html).toContain("Source");
  });

  test("renders a Count chip only when generating more than one", () => {
    expect(render({ decision: decision({ postCount: 1 }) })).not.toContain(
      "Count",
    );
    expect(
      render({ decision: decision({ mode: "create", taskKind: "post", postCount: 4 }) }),
    ).toContain("Count");
  });

  test("renders an amber conflict row with a Fix control", () => {
    const html = render({
      decision: decision({
        conflicts: [
          {
            field: "leadMagnet",
            message: "Lead magnet selected, but this is an ideas request — it won't be used",
            fix: "switch_mode",
          },
        ],
      }),
    });
    // renderToStaticMarkup HTML-escapes the apostrophe in "won't".
    expect(html).toMatch(/won(?:'|&#x27;)t be used/);
    expect(html).toContain("Fix");
  });

  test("renders no conflict row when there are no conflicts", () => {
    const html = render({ decision: decision({ conflicts: [] }) });
    expect(html).not.toContain("Fix");
  });

  test("a lead-magnet post reads as such in the summary", () => {
    const html = render({
      decision: decision({
        mode: "create",
        taskKind: "post",
        postType: "lead_magnet",
        postCount: 1,
      }),
    });
    expect(html).toContain("lead-magnet");
  });
});
