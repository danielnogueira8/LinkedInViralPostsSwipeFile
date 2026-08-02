import { describe, expect, test } from "vitest";
import type { Artifact } from "@/lib/agent/contracts";
import { tagArtifactWithLinkedInNativeGuidance } from "@/lib/agent/turn/artifact-tags";
import type { LinkedInNativeGuidance } from "@/lib/agent/linkedin-native-guidance";

const post: Artifact = {
  id: "draft-1",
  kind: "post",
  title: "Draft",
  body: "A complete post.",
  meta: { existing: true },
};

const guidance = {
  format: {
    id: "tactical_listicle",
    label: "Tactical Listicle",
    whenToUse: ["list"],
    requiredContext: ["topic"],
    structure: ["Promise", "Deliver"],
    avoid: ["generic filler"],
    exemplarPostIds: [],
  },
  promptBlock: "",
  exemplars: [
    {
      postId: "post-1",
      text: "Reference",
      similarity: 0.88,
      source: "semantic" as const,
    },
  ],
  retrievalMode: "semantic" as const,
} satisfies LinkedInNativeGuidance;

describe("tagArtifactWithLinkedInNativeGuidance", () => {
  test("persists retrieval provenance without persisting scraped post bodies", () => {
    const tagged = tagArtifactWithLinkedInNativeGuidance(post, guidance);

    expect(tagged.meta).toEqual({
      existing: true,
      linkedin_native_exemplars: [
        { post_id: "post-1", similarity: 0.88, source: "semantic" },
      ],
    });
    expect(JSON.stringify(tagged.meta)).not.toContain("Reference");
  });

  test("leaves cite artifacts untouched", () => {
    const cite: Artifact = {
      kind: "cite",
      id: "cite-1",
      title: "Source",
      body: "",
      meta: { postId: "00000000-0000-0000-0000-000000000001" },
    };
    expect(tagArtifactWithLinkedInNativeGuidance(cite, guidance)).toBe(cite);
  });
});
