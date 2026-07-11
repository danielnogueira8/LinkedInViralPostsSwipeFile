import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeChat,
  logOpenRouterUsage,
  readImageAnalysisCache,
  writeImageAnalysisCache,
} = vi.hoisted(() => ({
  completeChat: vi.fn(),
  logOpenRouterUsage: vi.fn(),
  readImageAnalysisCache: vi.fn(),
  writeImageAnalysisCache: vi.fn(),
}));

vi.mock("@/lib/openrouter", () => ({
  completeChat,
  generateImage: vi.fn(),
  logOpenRouterUsage,
  IMAGE_GENERATION_MODEL: "image/model",
}));

vi.mock("@/lib/image-analysis-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/image-analysis-cache")>();
  return {
    ...actual,
    readImageAnalysisCache,
    writeImageAnalysisCache,
  };
});

import { analyzeSourceImageLayout } from "@/lib/lead-magnet-image-generation";

const input = {
  dataUrl: "data:image/png;base64,AAAA",
  aspectRatio: "1:1",
  leadMagnetTitle: "Founder Toolkit",
  draftBody: 'Comment "TOOLKIT" to get it.',
  authorName: "John Doe",
  deliverables: ["Checklist"],
  workspaceId: "ws-1",
  sourcePostId: "post-1",
  leadMagnetId: "lm-1",
};

describe("lead magnet image analysis cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an exact cache hit without calling the vision model", async () => {
    readImageAnalysisCache.mockResolvedValue("cached layout");

    await expect(analyzeSourceImageLayout(input)).resolves.toEqual({
      text: "cached layout",
      usageCost: 0,
    });
    expect(completeChat).not.toHaveBeenCalled();
    expect(logOpenRouterUsage).not.toHaveBeenCalled();
    expect(writeImageAnalysisCache).not.toHaveBeenCalled();
  });

  it("writes a successful miss after logging paid usage", async () => {
    readImageAnalysisCache.mockResolvedValue(null);
    completeChat.mockResolvedValue({
      text: "  analyzed layout  ",
      usage: { cost: 0.01 },
    });

    await expect(analyzeSourceImageLayout(input)).resolves.toEqual({
      text: "analyzed layout",
      usageCost: 0.01,
    });
    expect(completeChat).toHaveBeenCalledTimes(1);
    expect(logOpenRouterUsage).toHaveBeenCalledTimes(1);
    expect(writeImageAnalysisCache).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        analysisKind: "lead_magnet_source_layout",
        resultText: "analyzed layout",
      }),
    );
  });
});
