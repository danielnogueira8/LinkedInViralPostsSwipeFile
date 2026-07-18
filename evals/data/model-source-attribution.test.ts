import { describe, expect, test } from "vitest";
import { modeledSourceAttribution } from "@/lib/model-source-attribution";

describe("modeledSourceAttribution", () => {
  test("keeps source identity when its URL is absent or unsafe", () => {
    expect(
      modeledSourceAttribution({
        source: "model_source",
        source_post_id: "post-123",
        source_url: "javascript:alert(1)",
      }),
    ).toEqual({ id: "post-123", url: null });
    expect(
      modeledSourceAttribution({
        source: "model_source",
        source_post_id: "post-456",
        source_url: "HTTPS://linkedin.com/posts/post-456",
      }),
    ).toEqual({
      id: "post-456",
      url: "https://linkedin.com/posts/post-456",
    });
    expect(modeledSourceAttribution({ source_post_id: "post-789" })).toBeNull();
  });
});
