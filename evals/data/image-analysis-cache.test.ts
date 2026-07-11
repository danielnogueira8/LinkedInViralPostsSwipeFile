import { beforeEach, describe, expect, it, vi } from "vitest";

const maybeSingle = vi.fn();
const upsert = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle }),
              }),
            }),
          }),
        }),
      }),
      upsert,
    }),
  }),
}));

import {
  imageAnalysisInputHash,
  readImageAnalysisCache,
  writeImageAnalysisCache,
} from "@/lib/image-analysis-cache";

describe("image analysis cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hashes the exact image, prompt, model, and prompt version", () => {
    const base = {
      dataUrl: "data:image/png;base64,AAAA",
      prompt: "Describe this image",
      model: "vision/model",
      promptVersion: 1,
    };
    const hash = imageAnalysisInputHash(base);
    expect(imageAnalysisInputHash(base)).toBe(hash);
    expect(imageAnalysisInputHash({ ...base, dataUrl: `${base.dataUrl}B` })).not.toBe(hash);
    expect(imageAnalysisInputHash({ ...base, prompt: `${base.prompt}.` })).not.toBe(hash);
    expect(imageAnalysisInputHash({ ...base, model: "other/model" })).not.toBe(hash);
    expect(imageAnalysisInputHash({ ...base, promptVersion: 2 })).not.toBe(hash);
  });

  it("returns an exact cached analysis", async () => {
    maybeSingle.mockResolvedValue({ data: { result_text: "  cached result  " }, error: null });
    await expect(
      readImageAnalysisCache({
        workspaceId: "ws-1",
        analysisKind: "chat_attachment_description",
        inputHash: "hash",
        model: "vision/model",
        promptVersion: 1,
      }),
    ).resolves.toBe("cached result");
  });

  it("fails open on cache read errors", async () => {
    maybeSingle.mockRejectedValue(new Error("cache unavailable"));
    await expect(
      readImageAnalysisCache({
        workspaceId: "ws-1",
        analysisKind: "chat_attachment_description",
        inputHash: "hash",
        model: "vision/model",
        promptVersion: 1,
      }),
    ).resolves.toBeNull();
  });

  it("stores only non-empty successful analyses", async () => {
    upsert.mockResolvedValue({ error: null });
    await writeImageAnalysisCache({
      workspaceId: "ws-1",
      analysisKind: "chat_attachment_description",
      inputHash: "hash",
      model: "vision/model",
      promptVersion: 1,
      resultText: "  result  ",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ result_text: "result" }),
      { onConflict: "workspace_id,analysis_kind,input_hash" },
    );

    await writeImageAnalysisCache({
      workspaceId: "ws-1",
      analysisKind: "chat_attachment_description",
      inputHash: "hash",
      model: "vision/model",
      promptVersion: 1,
      resultText: "   ",
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
