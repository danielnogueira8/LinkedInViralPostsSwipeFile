import { describe, expect, test } from "vitest";
import {
  buildLeadMagnetCampaign,
  enforceLeadMagnetCampaignCta,
  hasLeadMagnetRequestTopicOverlap,
  hasLeadMagnetResourceOverlap,
  leadMagnetSelectionPromptBeforeDraft,
  transformLeadMagnetCampaignDraft,
} from "@/lib/lead-magnet-campaign";

const RESOURCE = {
  id: "lm-banner",
  title: "LinkedIn Banner Checklist",
  markdown_body: [
    "# LinkedIn Banner Checklist",
    "",
    "A practical checklist for improving a LinkedIn profile banner.",
    "",
    "- Banner positioning checklist",
    "- Headline alignment worksheet",
  ].join("\n"),
  metadata: {
    summary: "A practical checklist for improving a LinkedIn profile banner.",
    deliverables: ["Banner positioning checklist", "Headline alignment worksheet"],
  },
  public_slug: "linkedin-banner-checklist-test",
  updated_at: "2026-07-12T00:00:00.000Z",
};

describe("lead-magnet campaign", () => {
  test("locks the selected resource and one CTA keyword before drafting", () => {
    const campaign = buildLeadMagnetCampaign(RESOURCE);

    expect(campaign.resource.id).toBe("lm-banner");
    expect(campaign.cta.keyword).toBe("BANNER");
    expect(campaign.promptBlock).toContain("LinkedIn Banner Checklist");
    expect(campaign.promptBlock).toContain("Banner positioning checklist");
    expect(campaign.promptBlock).toContain('Comment "BANNER"');
    expect(campaign.promptBlock).toContain("Do not substitute a different resource");
  });

  test("keeps the user's named topic authoritative over the selected giveaway", () => {
    const campaign = buildLeadMagnetCampaign(RESOURCE);

    expect(campaign.promptBlock).toContain(
      "The CURRENT REQUEST owns the post topic, thesis, and angle",
    );
    expect(campaign.promptBlock).toContain(
      "If the request names a product, model, version, person, event, or other subject, the post must explicitly discuss it",
    );
    expect(campaign.promptBlock).toContain(
      "The selected resource owns only the giveaway details and CTA",
    );

    const request = "Write a lead magnet about Opus 5 for content";
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Five prompts make content planning easier.",
        request,
      ),
    ).toBe(false);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Opus Five changes how I turn ideas into content.",
        request,
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "A useful post about sales.",
        "Write about five ways to improve sales",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Opus 5 changes content creation.",
        "Write about why Opus 5 matters for content",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Opus 5 is useful for content.",
        "Write about Opus 5.2 for content",
      ),
    ).toBe(false);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Opus 5.2 is useful for content.",
        "Write about Opus 5.2 for content",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "I've spent five years making posts.",
        "Write about my experience creating content for 5 years",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "My five favorite content tools.",
        "Write about the top 5 tools for content",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Five tools I use for content.",
        "Write about these 5 tools for content",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Five lessons we learned.",
        "Write about our 5 lessons",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Five useful frameworks.",
        "Write about these 5 frameworks",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Five lessons changed everything.",
        "Write about what changed over 5 years",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Five lessons remain.",
        "Write about all 5 lessons",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "My five-step framework.",
        "Write about a simple 5-step framework",
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "These prompts make content creation easier.",
        "Write about Claude 3.5 prompts for content",
      ),
    ).toBe(false);
    expect(
      hasLeadMagnetRequestTopicOverlap(
        "Opus Five changes content creation.",
        "Write about Opus version 5 for content",
      ),
    ).toBe(true);
    expect(
      transformLeadMagnetCampaignDraft(
        "Five prompts make content planning easier.",
        campaign,
        request,
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("Opus 5"),
    });
    expect(
      transformLeadMagnetCampaignDraft(
        "Opus 5 changes how people create content.",
        campaign,
        request,
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("LinkedIn Banner Checklist"),
    });
    expect(
      hasLeadMagnetResourceOverlap(
        "Opus 5 is useful, and your banner matters.",
        campaign,
      ),
    ).toBe(false);
    expect(
      transformLeadMagnetCampaignDraft(
        "Opus 5 changed my content workflow, so I turned the lesson into a banner checklist for clearer profile positioning.",
        campaign,
        request,
      ),
    ).toMatchObject({
      ok: true,
      body: expect.stringContaining('Comment "BANNER"'),
    });

    const promptsCampaign = buildLeadMagnetCampaign({
      ...RESOURCE,
      id: "lm-prompts",
      title: "5 Prompts to Create Better Content",
      markdown_body: "Five reusable content prompts.",
      metadata: {
        summary: "A practical set of five content prompts.",
        deliverables: ["Five reusable content prompts"],
      },
    });
    expect(
      transformLeadMagnetCampaignDraft(
        "Opus Five changes how I create.",
        promptsCampaign,
        request,
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("5 Prompts to Create Better Content"),
    });
  });

  test("selects from the request and source structure, never from a finished draft", () => {
    const prompt = leadMagnetSelectionPromptBeforeDraft({
      userText: "Model this lead-magnet post for my profile resource",
      sourceText: "Comment PROFILE and I will send my profile teardown.",
    });

    expect(prompt).toContain("Model this lead-magnet post");
    expect(prompt).toContain("Comment PROFILE");
    expect(prompt).not.toContain("Finished post draft");
    expect(prompt).not.toContain("Draft body");
  });

  test("rewrites a divergent comment keyword to the campaign keyword", () => {
    const campaign = buildLeadMagnetCampaign(RESOURCE);
    const body = enforceLeadMagnetCampaignCta(
      'The checklist is ready.\n\nComment "LINKEDIN" and I will send it.',
      campaign,
    );

    expect(body).toContain('Comment "BANNER"');
    expect(body).not.toContain('Comment "LINKEDIN"');
  });

  test("adds the canonical CTA when the model omitted a comment CTA", () => {
    const campaign = buildLeadMagnetCampaign(RESOURCE);
    const body = enforceLeadMagnetCampaignCta(
      "The checklist covers banner positioning and headline alignment.",
      campaign,
    );

    expect(body).toBe(
      'The checklist covers banner positioning and headline alignment.\n\nComment "BANNER" and I will send it.',
    );
  });

  test("rejects a post whose substance is unrelated to the selected resource", () => {
    const campaign = buildLeadMagnetCampaign(RESOURCE);

    expect(
      hasLeadMagnetResourceOverlap(
        "I made a cold email playbook with five outreach scripts.",
        campaign,
      ),
    ).toBe(false);
    expect(
      hasLeadMagnetResourceOverlap(
        "I turned my banner review into a checklist you can use on your profile.",
        campaign,
      ),
    ).toBe(true);
    expect(
      hasLeadMagnetResourceOverlap(
        "This generic post is only about creating better content.",
        campaign,
      ),
    ).toBe(false);
    expect(
      hasLeadMagnetResourceOverlap(
        'This post is about cold email. Comment "BANNER" and I will send it.',
        campaign,
      ),
    ).toBe(false);
  });
});
