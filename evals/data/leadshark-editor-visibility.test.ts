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

  it("remembers the created id so a second save reuses it", () => {
    const body = code(MODAL);
    expect(body).toContain("setCreatedForAutomationId(id)");
    expect(body).toContain("const automationDraftId = draft?.id ?? createdForAutomationId");
    // The resolver short-circuits rather than persisting again.
    expect(body).toContain("if (automationDraftId) return automationDraftId;");
  });

  it("keys the panel on the draft prop, not the resolved id", () => {
    // Two reasons, pulling in opposite directions:
    //  - keyed at all, because load() only SETS state when data exists, so an
    //    unkeyed panel carries the previous post's config across prev/next
    //    navigation — and PUTs it.
    //  - keyed on the PROP, because on a new post the resolved id appears
    //    mid-session when the automation saves; keying on that would remount
    //    the panel and discard the form the user had just filled in.
    expect(code(MODAL)).toContain('key={draft?.id ?? "new"}');
  });
});

describe("the form works before the post exists", () => {
  const PANEL = readFileSync(
    path.join(process.cwd(), "app/(app)/dashboard/leadshark-panel.tsx"),
    "utf8",
  );

  it("renders the panel itself, not a button that gates it", () => {
    // The first version put a "Set up comment-to-DM automation" button here
    // that created the post before showing any fields. Being told to create
    // the post BEFORE you can type the DM is backwards — the fields are the
    // point, and the post is an implementation detail of saving them.
    const body = code(MODAL);
    expect(body).toContain("ensureDraftId={ensureAutomationDraftId}");
    expect(body).not.toContain("Set up comment-to-DM automation");
  });

  it("accepts a null draft id", () => {
    expect(code(PANEL)).toContain("draftId: string | null");
  });

  it("skips the per-draft GET when there is no draft", () => {
    // The per-draft route 404s on an id that does not exist yet. Falling back
    // to the workspace credential check is what keeps "connect LeadShark
    // first" working on an unsaved post.
    const body = code(PANEL);
    expect(body).toContain("if (!draftId) {");
    expect(body).toContain('"/api/integrations/leadshark"');
  });

  it("creates the post on SAVE, never on mount", () => {
    // The whole point of the redesign: opening the editor must still write
    // nothing. If ensureDraftId were called from load(), merely selecting
    // "Lead Magnet Post" would start creating rows.
    const body = code(PANEL);
    const loadStart = body.indexOf("const load = useCallback");
    const loadEnd = body.indexOf("const patch =");
    expect(loadStart).toBeGreaterThan(-1);
    expect(body.slice(loadStart, loadEnd)).not.toContain("ensureDraftId");
    expect(body).toContain("await ensureDraftId?.()");
  });

  it("writes to the resolved id, so one save cannot become two posts", () => {
    const body = code(PANEL);
    expect(body).toContain("const targetId = resolvedId ?? (await ensureDraftId?.()) ?? null");
    expect(body).toContain("`/api/drafts/${targetId}/automation`");
    // Delete has to follow the same id, not the (possibly null) prop.
    expect(body).toContain("`/api/drafts/${resolvedId}/automation`");
  });
});
