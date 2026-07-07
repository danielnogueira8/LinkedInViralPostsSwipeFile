import { describe, expect, test } from "vitest";
import {
  buildLeadMagnetImagePrompt,
  inferCommentKeyword,
  shouldGenerateLeadMagnetImage,
} from "@/lib/lead-magnet-image-generation";

const sourceImage = {
  postId: "post-1",
  mediaType: "image",
  imageUrl: "https://example.com/source.png",
};

const leadMagnet = {
  id: "lm-1",
  title: "The AI Toolkit for HR",
};

describe("lead magnet image generation", () => {
  test("triggers only for lead-magnet post drafts with image source posts", () => {
    expect(
      shouldGenerateLeadMagnetImage({
        artifact: { kind: "post" },
        leadMagnet,
        sourceImage,
      }),
    ).toBe(true);

    expect(
      shouldGenerateLeadMagnetImage({
        artifact: { kind: "hook" },
        leadMagnet,
        sourceImage,
      }),
    ).toBe(false);

    expect(
      shouldGenerateLeadMagnetImage({
        artifact: { kind: "post" },
        leadMagnet,
        sourceImage: { ...sourceImage, mediaType: "video" },
      }),
    ).toBe(false);

    expect(
      shouldGenerateLeadMagnetImage({
        artifact: { kind: "post" },
        leadMagnet: null,
        sourceImage,
      }),
    ).toBe(false);
  });

  test("extracts a clean comment keyword and falls back to title/guide", () => {
    expect(inferCommentKeyword('Comment "TOOLKIT" and connect with me.', "AI HR Toolkit")).toBe(
      "TOOLKIT",
    );
    expect(inferCommentKeyword("Want it? Comment below.", "Revenue Playbook")).toBe(
      "REVENUE",
    );
    expect(inferCommentKeyword("Want it? Comment below.", "The 3 best ways")).toBe(
      "GUIDE",
    );
  });

  test("prompt rebrands the source image around the selected lead magnet", () => {
    const prompt = buildLeadMagnetImagePrompt({
      leadMagnet: {
        title: "The AI Toolkit for HR",
        metadata: {
          deliverables: ["Prompt library", "Workflow checklist"],
        },
      },
      draftBody: 'Comment "TOOLKIT" and I will send it.',
      author: { name: "Ethos One" },
      aspectRatio: "1:1",
    });

    expect(prompt).toContain("layout and style reference");
    expect(prompt).toContain('Brand/logo text: "Ethos One"');
    expect(prompt).toContain('Main headline: "The AI Toolkit for HR"');
    expect(prompt).toContain('Comment "TOOLKIT" to get it');
    expect(prompt).toContain("Prompt library; Workflow checklist");
    expect(prompt).toContain("Do not copy the original creator");
  });
});
