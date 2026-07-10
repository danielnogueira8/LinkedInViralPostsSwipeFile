import { describe, expect, test, vi } from "vitest";
import {
  LEAD_MAGNET_AI_MONTHLY_LIMIT,
  extractCtas,
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

vi.mock("node:dns/promises", () => ({
  default: {
    lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
  },
}));

describe("lead magnets", () => {
  test("uses a ten-per-user AI monthly limit", () => {
    expect(LEAD_MAGNET_AI_MONTHLY_LIMIT).toBe(10);
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

  test("rejects non-http lead magnet URLs", () => {
    expect(
      leadMagnetInputSchema.safeParse({
        title: "Checklist",
        markdown_body: "# Checklist\n\nA useful resource.",
        source_url: "ftp://example.com/resource",
      }).success,
    ).toBe(false);
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

  test("extracts multiple CTA links from imported lead magnet content", () => {
    const markdown = [
      "# Cold DM Playbook",
      "",
      "Want the done-with-you version? [Book a 30-min call](https://calendly.com/acme/call).",
      "",
      "Prefer to see the offer first? [Apply here](https://example.com/apply).",
    ].join("\n");
    const ctas = extractCtas(markdown);
    const meta = normalizeLeadMagnetMetadata(null, markdown);

    expect(ctas).toEqual([
      { label: "Book a 30-min call", url: "https://calendly.com/acme/call" },
      { label: "Apply here", url: "https://example.com/apply" },
    ]);
    expect(meta.cta_url).toBe("https://calendly.com/acme/call");
    expect(meta.cta_label).toBe("Book a 30-min call");
    expect(meta.ctas).toEqual(ctas);
  });

  test("respects explicit CTA edits instead of reusing imported CTA metadata", () => {
    const markdown = [
      "# Cold DM Playbook",
      "",
      "Prefer to skip the DIY? [Book a call](https://calendly.com/acme/call).",
    ].join("\n");

    expect(
      normalizeLeadMagnetMetadata(
        { cta_url: "", cta_label: "", ctas: [] },
        markdown,
      ),
    ).toMatchObject({
      cta_url: null,
      cta_label: null,
      ctas: [],
    });

    expect(
      normalizeLeadMagnetMetadata(
        {
          cta_url: "https://example.com/audit",
          cta_label: "Get the audit",
          ctas: [{ url: "https://example.com/audit", label: "Get the audit" }],
        },
        markdown,
      ).ctas,
    ).toEqual([{ url: "https://example.com/audit", label: "Get the audit" }]);
  });

  test("keeps CTA URLs out of lead magnet post prompt context", () => {
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

    expect(context).toContain("Deliverables:");
    expect(context).not.toContain("https://example.com/call");
    expect(context).not.toContain("Book a strategy call");
    expect(context).not.toContain("CTA");
  });

  test("does not expose lead magnet CTA metadata when writing post copy", () => {
    const context = leadMagnetPromptContext({
      title: "Cold DM Playbook",
      markdown_body: [
        "# Cold DM Playbook",
        "",
        "Use these prompts.",
        "",
        "Want feedback on your story tweets or a content strategy built around them? [Book a 30-min call](https://calendly.com/acme/call) and let's map it out together.",
      ].join("\n"),
        metadata: {
          summary: "Prompt pack for cold DMs",
          deliverables: ["Message prompts"],
          cta_url: "https://calendly.com/acme/call",
          cta_label: "Book a strategy call",
          ctas: [
            { label: "Book a strategy call", url: "https://calendly.com/acme/call" },
            { label: "Apply here", url: "https://example.com/apply" },
          ],
        },
      });

    expect(context).not.toContain("https://www.linkedin.com/in/danielnogueira/");
    expect(context).not.toContain("https://calendly.com/acme/call");
    expect(context).not.toContain("https://example.com/apply");
    expect(context).not.toContain("Book a 30-min call");
    expect(context).not.toContain("CTA");
  });

  test("does not add fallback CTA instructions when a lead magnet has no CTA URL", () => {
    const context = leadMagnetPromptContext({
      title: "Cold DM Playbook",
      markdown_body: "# Cold DM Playbook\n\nUse these prompts.",
      metadata: {
        summary: "Prompt pack for cold DMs",
        deliverables: ["Message prompts"],
      },
    });

    expect(context).not.toContain("CTA link:");
    expect(context).not.toContain("CTA fallback:");
    expect(context).not.toContain("CTA");
    expect(context).not.toContain("https://www.linkedin.com/in/danielnogueira/");
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

  test("blocks local/private import URLs before fetching", async () => {
    await expect(importLeadMagnetFromUrl("http://localhost:3000/internal")).rejects.toThrow(
      "Use a public URL",
    );
    await expect(importLeadMagnetFromUrl("http://127.0.0.1/internal")).rejects.toThrow(
      "Use a public URL",
    );
    await expect(importLeadMagnetFromUrl("ftp://example.com/resource")).rejects.toThrow(
      "Use an http or https public URL.",
    );
  });

  test("blocks private redirect targets during import", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/internal" },
    }));
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await expect(importLeadMagnetFromUrl("https://93.184.216.34/resource")).rejects.toThrow(
        "Use a public URL",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects oversized import responses before buffering the body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("This body should not need to be read.", {
        status: 200,
        headers: { "content-length": "1500001", "content-type": "text/plain" },
      })) as typeof fetch;
    try {
      await expect(importLeadMagnetFromUrl("https://93.184.216.34/resource")).rejects.toThrow(
        "too large to import",
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
