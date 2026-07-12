import { describe, expect, test } from "vitest";
import {
  buildLeadMagnetCampaign,
  enforceLeadMagnetCampaignCta,
  hasLeadMagnetResourceOverlap,
  leadMagnetSelectionPromptBeforeDraft,
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
        'This post is about cold email. Comment "BANNER" and I will send it.',
        campaign,
      ),
    ).toBe(false);
  });
});
