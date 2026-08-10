import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Who gets to see the comment-to-DM automation.
//
// The API has always been kind-only: eligible = draft.kind === "lead_magnet",
// with the DM prefilled as "your link" when no giveaway resource is attached.
// The editor was stricter than that in two ways, and both hid a feature the
// backend already supported — a lead-magnet post with Giveaway: None, and a
// post that had not been created yet.
//
// The suite is Node-only, so these read the source. What they pin are the
// CONDITIONS, which is exactly what silently drifted.
// ---------------------------------------------------------------------------

const MODAL = readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/draft-editor-modal.tsx"),
  "utf8",
);
// The server's own rule is pinned in giveaway-picker-load.test.ts
// ("eligibility is the post kind alone"); these cover the editor side of it.

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("automation visibility follows the API's own rule", () => {
  it("the editor decides on kind, never on the giveaway", () => {
    const body = code(MODAL);
    const decision = body.slice(
      body.indexOf("const automationKindIsLeadMagnet"),
      body.indexOf("const automationDraftId"),
    );
    expect(decision).toContain('newKind === "lead_magnet"');
    expect(decision).toContain('draft?.kind === "lead_magnet"');
    // The giveaway is a separate choice — a lead-magnet post can DM a link
    // that was never stored as a resource.
    expect(decision).not.toContain("LeadMagnetId");
    expect(decision).not.toContain("leadMagnet");
  });

  it("a new post can reach it, not only a saved one", () => {
    // The gate used to be `!isNew && ...`, so the panel was unreachable on the
    // New post screen — which reads as "lead magnets don't support this".
    //
    // Asserted on the JSX GUARD LINE, matching what sits between `{` and the
    // flag. An earlier version sliced forward from the flag name, which put a
    // reintroduced `!isNew &&` just outside the window — it passed with the
    // bug restored, caught by mutation rather than by reading it.
    const guard = /^\s*\{([^\n]*?)automationKindIsLeadMagnet\s*&&/m.exec(
      code(MODAL),
    );
    expect(guard).not.toBeNull();
    expect(guard![1].trim()).toBe("");
  });
});

describe("creating on demand cannot duplicate the post", () => {
  it("persistBody updates once a draft exists, whatever created it", () => {
    // Setting up the automation persists the post so the panel has an id. A
    // later Save or Schedule calls persistBody AGAIN, and while `isNew` is
    // still true that would take the create branch and write a second post.
    // The reuse guard must therefore not be scoped to the queue-retry case it
    // was originally written for.
    const body = code(MODAL);
    expect(body).toContain("if (createdDraftIdRef.current) {");
    expect(body).not.toContain("if (initialQueueTarget && createdDraftIdRef.current)");
  });

  it("remembers the created id in state, so the panel actually appears", () => {
    // A ref alone would not re-render: the post would be created and the
    // button would just sit there.
    const body = code(MODAL);
    expect(body).toContain("setCreatedForAutomationId(id)");
    expect(body).toContain("const automationDraftId = draft?.id ?? createdForAutomationId");
  });

  it("keys the panel on the draft id", () => {
    // load() only SETS state when data exists, so an unkeyed panel would carry
    // the previous post's config across prev/next navigation — and PUT it.
    expect(code(MODAL)).toContain("key={automationDraftId}");
  });
});
