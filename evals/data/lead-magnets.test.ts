import { describe, expect, test } from "vitest";
import {
  LEAD_MAGNET_AI_MONTHLY_LIMIT,
  extractDeliverables,
  leadMagnetInputSchema,
  makePublicSlug,
  monthStartIso,
  normalizeLeadMagnetMetadata,
  selectLeadMagnetForPrompt,
} from "@/lib/lead-magnets";
import { extractNotionPageId, isNotionUrl, parseNotionRecordMap } from "@/lib/lead-magnet-import";

describe("lead magnets", () => {
  test("uses a five-per-user AI monthly limit", () => {
    expect(LEAD_MAGNET_AI_MONTHLY_LIMIT).toBe(5);
  });

  test("computes a UTC month boundary for monthly caps", () => {
    expect(monthStartIso(new Date("2026-07-31T23:59:59.000Z"))).toBe("2026-07-01T00:00:00.000Z");
  });

  test("creates unguessable title-based public slugs", () => {
    expect(makePublicSlug("LinkedIn Content Audit Checklist")).toMatch(
      /^linkedin-content-audit-checklist-[a-f0-9]{8}$/,
    );
  });

  test("validates markdown document inputs", () => {
    expect(
      leadMagnetInputSchema.safeParse({
        title: "Checklist",
        markdown_body: "# Checklist\n\n- Hook\n- CTA",
        is_public: true,
      }).success,
    ).toBe(true);
    expect(leadMagnetInputSchema.safeParse({ title: "", markdown_body: "" }).success).toBe(false);
  });

  test("extracts deliverables from markdown lists", () => {
    expect(
      extractDeliverables(`# Resource\n\n- Hook checklist.\n- CTA swipe file\n1. DM script:`),
    ).toEqual(["Hook checklist", "CTA swipe file", "DM script"]);
  });

  test("normalizes metadata with derived summary and deliverables", () => {
    const meta = normalizeLeadMagnetMetadata(null, [
      "# Founder content kit",
      "",
      "Use this to turn customer calls into useful LinkedIn posts for your audience.",
      "",
      "- Call notes checklist",
      "- Post angle map",
    ].join("\n"));
    expect(meta.summary).toContain("turn customer calls");
    expect(meta.selection_summary).toContain("Call notes checklist");
    expect(meta.deliverables).toEqual(["Call notes checklist", "Post angle map"]);
  });

  test("selects the most relevant lead magnet for a prompt", () => {
    const selected = selectLeadMagnetForPrompt("Create a lead magnet post about a hook audit", [
      {
        id: "calendar",
        title: "Content Calendar",
        metadata: { summary: "A month of posting ideas", deliverables: ["Calendar"] },
        updated_at: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "hook-audit",
        title: "Hook Audit Checklist",
        metadata: {
          summary: "A resource for diagnosing weak hooks",
          deliverables: ["Hook scorecard", "Opening line checklist"],
        },
        updated_at: "2026-06-01T00:00:00.000Z",
      },
    ]);

    expect(selected?.id).toBe("hook-audit");
  });

  test("recognizes public Notion URLs and extracts page ids", () => {
    expect(isNotionUrl("https://daniel.notion.site/My-Resource-1234567890abcdef1234567890abcdef")).toBe(true);
    expect(isNotionUrl("https://example.com/page")).toBe(false);
    expect(
      extractNotionPageId(
        "https://www.notion.so/My-Resource-1234567890abcdef1234567890abcdef?pvs=4",
      ),
    ).toBe("12345678-90ab-cdef-1234-567890abcdef");
    expect(
      extractNotionPageId(
        "https://www.notion.so/page?p=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ),
    ).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  test("parses current Notion loadPageChunk nested block records", () => {
    const parsed = parseNotionRecordMap(
      {
        block: {
          "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": {
            value: {
              value: {
                id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                type: "page",
                properties: {
                  title: [["Cold DM Playbook"]],
                },
                content: ["bbbbbbbb-cccc-dddd-eeee-ffffffffffff"],
              },
            },
          },
          "bbbbbbbb-cccc-dddd-eeee-ffffffffffff": {
            value: {
              value: {
                id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
                type: "text",
                properties: {
                  title: [["Use these prompts to write sharper LinkedIn messages that get positive replies."]],
                },
              },
            },
          },
        },
      },
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "https://example.notion.site/Cold-DM-Playbook-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    expect(parsed?.title).toBe("Cold DM Playbook");
    expect(parsed?.markdown).toContain("# Cold DM Playbook");
    expect(parsed?.markdown).toContain("sharper LinkedIn messages");
  });
});
