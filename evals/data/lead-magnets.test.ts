import { describe, expect, test } from "vitest";
import {
  LEAD_MAGNET_AI_MONTHLY_LIMIT,
  extractCtaUrl,
  extractDeliverables,
  leadMagnetPromptContext,
  leadMagnetInputSchema,
  makePublicSlug,
  monthStartIso,
  normalizeLeadMagnetMetadata,
  selectLeadMagnetForPrompt,
} from "@/lib/lead-magnets";
import {
  extractNotionPageId,
  importLeadMagnetFromUrl,
  isNotionUrl,
  parseNotionRecordMap,
} from "@/lib/lead-magnet-import";

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

  test("extracts and preserves a CTA URL from lead magnet content", () => {
    const markdown = [
      "# Cold DM Playbook",
      "",
      "Use this to write better outbound messages.",
      "",
      "> Book a 30-minute strategy call → https://calendly.com/vantagegroup/linkedin-strategy-consultation",
    ].join("\n");
    const meta = normalizeLeadMagnetMetadata(null, markdown);

    expect(extractCtaUrl(markdown)).toBe(
      "https://calendly.com/vantagegroup/linkedin-strategy-consultation",
    );
    expect(meta.cta_url).toBe("https://calendly.com/vantagegroup/linkedin-strategy-consultation");
    expect(meta.cta_label).toBe("Book a call");
    expect(normalizeLeadMagnetMetadata({ cta_url: "" }, markdown).cta_url).toBeNull();
  });

  test("includes CTA URL in lead magnet prompt context", () => {
    const context = leadMagnetPromptContext({
      title: "Cold DM Playbook",
      markdown_body: "# Cold DM Playbook\n\nUse these prompts.",
      metadata: {
        summary: "Prompt pack for cold DMs",
        deliverables: ["Message prompts"],
        cta_url: "https://example.com/call",
        cta_label: "Book a strategy call",
      },
    });

    expect(context).toContain("CTA link: Book a strategy call — https://example.com/call");
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

  test("normalizes generic fetch failures into a useful import error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    try {
      await expect(importLeadMagnetFromUrl("https://example.com/resource")).rejects.toThrow(
        "I couldn't reach that public page.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not mislabel Notion network failures as sharing failures", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    try {
      await expect(
        importLeadMagnetFromUrl(
          "https://example.notion.site/Public-Resource-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
      ).rejects.toThrow("I couldn't reach that public page.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
