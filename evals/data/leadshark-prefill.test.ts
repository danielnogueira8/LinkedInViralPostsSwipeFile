import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAutomationPrefill } from "@/lib/leadshark-prefill";
import type { LeadSharkAutomationDefaults } from "@/lib/leadshark-default-config";

// ---------------------------------------------------------------------------
// A new post and a saved post must start from the SAME automation config.
//
// Reported by a user: setting Kind to Lead Magnet Post and opening the
// automation on a brand-new post showed every field empty. Creating the post,
// reopening it, and opening the automation again showed their saved defaults.
// Same screen, same workspace, different answer depending on whether a row
// happened to exist yet — which reads as "my settings didn't save".
//
// The prefill only existed on the per-draft route. It now lives in one builder
// both routes call, and these pin that it actually applies the defaults.
// ---------------------------------------------------------------------------

const DEFAULTS: LeadSharkAutomationDefaults = {
  keywords: ["PLACEHOLDER"],
  dmTemplate: "Hey {{firstName}}, here is {{resourceName}}: {{resourceUrl}}",
  dmTemplateVariations: ["Hi {{firstName}} — {{resourceUrl}}"],
  commentReplyTemplates: ["Sent, {{firstName}}!"],
  nonConnectionReplyTemplates: ["Connect and I'll send {{resourceName}}"],
  autoConnect: true,
  autoLike: true,
  followUpEnabled: true,
  followUpTemplate: "Did {{resourceName}} land?",
  followUpDelayMinutes: 1440,
  followUpOnlyIfNoResponse: false,
};

describe("the workspace's saved defaults are applied", () => {
  it("carries every non-template setting through", () => {
    // These are the ones the user notices missing: their toggles and their
    // follow-up delay, reset to the built-in values.
    const prefill = buildAutomationPrefill({
      leadMagnet: null,
      body: "Comment SYSTEM and I'll send it over.",
      origin: "https://app.example.com",
      savedDefaults: DEFAULTS,
    });
    expect(prefill.config.autoConnect).toBe(true);
    expect(prefill.config.autoLike).toBe(true);
    expect(prefill.config.followUpEnabled).toBe(true);
    expect(prefill.config.followUpDelayMinutes).toBe(1440);
    expect(prefill.config.followUpOnlyIfNoResponse).toBe(false);
    expect(prefill.config.commentReplyTemplates).toHaveLength(1);
    expect(prefill.config.dmTemplateVariations).toHaveLength(1);
  });

  it("still fills the DM when no resource is attached", () => {
    // Giveaway: None is a supported case, so the template resolves against
    // "your link" rather than coming back blank.
    const prefill = buildAutomationPrefill({
      leadMagnet: null,
      body: "Comment SYSTEM.",
      origin: "https://app.example.com",
      savedDefaults: DEFAULTS,
    });
    expect(prefill.config.dmTemplate).toContain("your link");
    expect(prefill.leadMagnetId).toBeNull();
    expect(prefill.leadMagnetUrl).toBeNull();
  });

  it("resolves the hosted URL when a resource IS attached", () => {
    const prefill = buildAutomationPrefill({
      leadMagnet: { id: "lm-1", title: "The Playbook", publicSlug: "the-playbook" },
      body: "Comment PLAYBOOK.",
      origin: "https://app.example.com",
      savedDefaults: DEFAULTS,
    });
    expect(prefill.leadMagnetUrl).toBe("https://app.example.com/lm/the-playbook");
    expect(prefill.config.dmTemplate).toContain(
      "https://app.example.com/lm/the-playbook",
    );
    expect(prefill.config.dmTemplate).toContain("The Playbook");
    expect(prefill.leadMagnetId).toBe("lm-1");
  });

  it("falls back to a usable config when the workspace saved none", () => {
    // A workspace that never opened the defaults editor must still get a DM
    // template, not an empty box.
    const prefill = buildAutomationPrefill({
      leadMagnet: null,
      body: "Comment SYSTEM.",
      origin: "https://app.example.com",
      savedDefaults: null,
    });
    expect(prefill.config.dmTemplate.trim()).not.toBe("");
    expect(prefill.config.followUpDelayMinutes).toBe(60);
  });

  it("never returns an empty DM template with defaults present", () => {
    // The regression in one line: an empty template IS the reported bug.
    for (const lm of [null, { id: "x", title: "Guide", publicSlug: "guide" }]) {
      const prefill = buildAutomationPrefill({
        leadMagnet: lm,
        body: "",
        origin: "https://app.example.com",
        savedDefaults: DEFAULTS,
      });
      expect(prefill.config.dmTemplate.trim()).not.toBe("");
    }
  });
});

describe("both routes share one builder", () => {
  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  const PER_DRAFT = readFileSync(
    path.join(process.cwd(), "app/api/drafts/[id]/automation/route.ts"),
    "utf8",
  );
  const PREFILL_ROUTE = readFileSync(
    path.join(process.cwd(), "app/api/drafts/automation-prefill/route.ts"),
    "utf8",
  );
  const PANEL = readFileSync(
    path.join(process.cwd(), "app/(app)/dashboard/leadshark-panel.tsx"),
    "utf8",
  );

  it("the saved-post route calls it rather than inlining the logic", () => {
    // Inlining is how the two drifted in the first place.
    expect(code(PER_DRAFT)).toContain("buildAutomationPrefill({");
    expect(code(PER_DRAFT)).not.toContain("materializeLeadSharkAutomationDefaults");
  });

  it("the new-post route calls the same builder", () => {
    expect(code(PREFILL_ROUTE)).toContain("buildAutomationPrefill({");
  });

  it("the new-post route reads, never writes", () => {
    // Opening the form must still leave no trace — that was the point of
    // resolving the draft id on save instead of on mount.
    const body = code(PREFILL_ROUTE);
    expect(body).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });

  it("scopes the giveaway lookup to the workspace", () => {
    // An id from another workspace must resolve to nothing, not to its title.
    expect(code(PREFILL_ROUTE)).toContain('.eq("workspace_id", sb.workspaceId)');
  });

  it("the panel seeds its form from the prefill it fetches", () => {
    // Fetching and then ignoring it would look identical to the bug.
    const body = code(PANEL);
    const branch = body.slice(
      body.indexOf("if (!draftId) {"),
      body.indexOf("const res = await fetchJson<GetResponse>"),
    );
    expect(branch).toContain('"/api/drafts/automation-prefill"');
    expect(branch).toContain("...res.prefill!.config");
  });
});
