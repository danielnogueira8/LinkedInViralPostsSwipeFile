import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildSourceImageAnalysisPrompt,
  buildLeadMagnetImagePrompt,
  LEAD_MAGNET_IMAGE_ANALYSIS_MODEL,
  LEAD_MAGNET_IMAGE_FALLBACK_MODEL,
  fetchSourceImageDataUrl,
  genericLeadMagnetImageContextFromDraft,
  inferAspectRatioFromImageBytes,
  inferCommentKeyword,
  shouldFallbackLeadMagnetImageModel,
  shouldGenerateLeadMagnetImage,
} from "@/lib/lead-magnet-image-generation";
import { IMAGE_GENERATION_MODEL } from "@/lib/openrouter";

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
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

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
        leadMagnet: { id: null, title: "Auto lead magnet" },
        sourceImage,
      }),
    ).toBe(true);

    expect(
      shouldGenerateLeadMagnetImage({
        artifact: { kind: "post" },
        leadMagnet: null,
        sourceImage,
      }),
    ).toBe(false);
  });

  test("uses GPT Image mini as the primary model and Gemini 3 Pro image as fallback", () => {
    expect(IMAGE_GENERATION_MODEL).toBe("openai/gpt-image-1-mini");
    expect(LEAD_MAGNET_IMAGE_FALLBACK_MODEL).toBe("google/gemini-3-pro-image");
    expect(LEAD_MAGNET_IMAGE_ANALYSIS_MODEL).toBe("google/gemini-3-flash-preview");
  });

  test("falls back only for likely image complexity or edit capability failures", () => {
    expect(
      shouldFallbackLeadMagnetImageModel(
        new Error("OpenRouter 400 Bad Request: image is too complex to edit"),
      ),
    ).toBe(true);
    expect(
      shouldFallbackLeadMagnetImageModel(
        new Error("OpenRouter 400 Bad Request: unsupported input_references"),
      ),
    ).toBe(true);
    expect(
      shouldFallbackLeadMagnetImageModel(
        new Error("OpenRouter 402 Payment Required: insufficient credits"),
      ),
    ).toBe(false);
    expect(
      shouldFallbackLeadMagnetImageModel(
        new Error("OpenRouter 429 Too Many Requests: rate limit"),
      ),
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
      visualAnalysis:
        "White background. Three objects in one horizontal row: LinkedIn logo left, avatar center, metric text right. Large plus and equals signs between objects. No buttons or badges.",
    });

    expect(prompt).toContain("source image to edit");
    expect(prompt).toContain("STRICT IMAGE EDITING TASK");
    expect(prompt).toContain("Do not redesign it");
    expect(prompt).toContain("Source layout analysis to preserve");
    expect(prompt).toContain("Three objects in one horizontal row");
    expect(prompt).toContain("Make the smallest possible targeted changes");
    expect(prompt).toContain("Do not add new names");
    expect(prompt).toContain('Only if the source already has a brand/name text slot');
    expect(prompt).toContain('"Ethos One"');
    expect(prompt).toContain('Only if the source already has a headline/title slot');
    expect(prompt).toContain('"The AI Toolkit for HR"');
    expect(prompt).toContain('Comment "TOOLKIT" to get it');
    expect(prompt).toContain("Prompt library; Workflow checklist");
    expect(prompt).toContain("Do not copy the original creator");
  });

  test("analysis prompt asks for a preservation-focused visual spec", () => {
    const prompt = buildSourceImageAnalysisPrompt({
      aspectRatio: "3:2",
      leadMagnetTitle: "The AI Toolkit for HR",
    });

    expect(prompt).toContain("minimal image-editing step");
    expect(prompt).toContain("Do not suggest a redesign");
    expect(prompt).toContain("object order and approximate positions");
    expect(prompt).toContain("text slots");
    expect(prompt).toContain("Known source aspect ratio: 3:2");
    expect(prompt).toContain("The AI Toolkit for HR");
  });

  test("infers source aspect ratio from image bytes instead of defaulting square", () => {
    const png = Buffer.alloc(24);
    png[0] = 0x89;
    png[1] = 0x50;
    png[2] = 0x4e;
    png[3] = 0x47;
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(720, 20);

    expect(inferAspectRatioFromImageBytes(png, "image/png")).toBe("3:2");
  });

  test("fetches CDN images with bad content-type by sniffing the bytes", async () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x04, 0x38, 0x03,
      0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ]);
    global.fetch = vi.fn(async () => {
      return new Response(jpeg, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as typeof fetch;

    const image = await fetchSourceImageDataUrl("https://media.example.com/image");

    expect(image.mimeType).toBe("image/jpeg");
    expect(image.dataUrl).toContain("data:image/jpeg;base64,");
  });

  test("rejects gif source images instead of sending them to image generation", async () => {
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "binary");
    global.fetch = vi.fn(async () => {
      return new Response(gif, {
        status: 200,
        headers: { "content-type": "image/gif" },
      });
    }) as typeof fetch;

    await expect(fetchSourceImageDataUrl("https://media.example.com/image.gif")).rejects.toThrow(
      "GIF sources are not supported",
    );
  });

  test("builds a generic image context from the draft when no saved resource exists", () => {
    const context = genericLeadMagnetImageContextFromDraft({
      title: "Draft",
      body: [
        "Comment \"AUDIT\" and I will send the LinkedIn audit checklist.",
        "",
        "- Hook scorecard",
        "- CTA template",
      ].join("\n"),
    });

    expect(context.id).toBeNull();
    expect(context.title).toContain("LinkedIn audit checklist");
    expect(context.metadata?.deliverables).toContain("Hook scorecard");
  });
});
