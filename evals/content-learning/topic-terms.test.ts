import { describe, expect, test } from "vitest";
import {
  clusterTopicTerms,
  extractTopicCandidates,
} from "@/lib/content-learning/topic-terms";

// Topic-term extraction + clustering — the fallback path for published posts
// with NO lineage topic descriptor (the common case). The old fallback keyed
// topics on the artifact title (first 60 chars of the body, cut mid-word),
// so every post was a singleton "topic" and the card showed broken
// headlines. These pin readable labels and real clusters.

describe("extractTopicCandidates", () => {
  test("pulls the thematic phrase, not hook glue", () => {
    const labels = extractTopicCandidates(
      "Stop hiring a LinkedIn ghostwriter if you don't have a voice yet.",
    ).map((candidate) => candidate.label);
    expect(labels).toContain("LinkedIn ghostwriter");
    expect(labels[0]).not.toMatch(/^(Stop|If|Don't)\b/);
  });

  test("finds number-adjacent phrases without the numbers", () => {
    const labels = extractTopicCandidates(
      "If your posts get likes but zero booked calls, stop writing for applause.",
    ).map((candidate) => candidate.label);
    expect(labels).toContain("Booked calls");
    expect(labels.join(" ")).not.toContain("zero");
  });

  test("splits slash-joined terms into a readable phrase", () => {
    const labels = extractTopicCandidates(
      "Everyone talks about using AI/Agents to write LinkedIn posts.",
    ).map((candidate) => candidate.label);
    expect(labels).toContain("AI Agents");
  });

  test("labels are capitalized but preserve inner casing", () => {
    const labels = extractTopicCandidates(
      "If your posts get likes but zero booked calls, stop writing.",
    ).map((candidate) => candidate.label);
    for (const label of labels) {
      expect(label[0]).toBe(label[0]?.toUpperCase());
    }
  });

  test("a body with no topical content yields no candidates", () => {
    expect(extractTopicCandidates("I changed my mind about posting more this year.")).toEqual([]);
  });
});

describe("clusterTopicTerms", () => {
  const POSTS = [
    "Everyone talks about using AI/Agents to write LinkedIn posts. Nobody talks about the boring part that actually gets you clients.",
    "The best advice I ever received about content: nobody cares how smart you are.",
    "Stop hiring a LinkedIn ghostwriter if you don't have a voice yet.",
    "If your posts get likes but zero booked calls, stop writing for applause.",
    "I changed my mind about posting more this year.",
    "My own LinkedIn page is probably the most neglected sales asset I own.",
    "The best advice I ever received: sell the hole, not the drill.",
    "Your LinkedIn profile can kill a sale before your content gets a chance.",
  ];

  test("posts sharing a theme cluster; the rest stay honest singletons", () => {
    const clusters = clusterTopicTerms(POSTS, (post) =>
      extractTopicCandidates(post),
    );
    const byLabel = new Map(
      clusters.map((cluster) => [cluster.label, cluster.members.length]),
    );
    // The two "best advice" posts share a real topic with a real count.
    expect(byLabel.get("Best advice")).toBe(2);
    // Every label is a readable phrase — never a truncated headline.
    for (const label of byLabel.keys()) {
      expect(label.length).toBeLessThan(40);
      expect(label).not.toMatch(/\b(ge|th|tha)\b$/);
    }
    // Nothing is lost: every post is in exactly one cluster.
    expect(clusters.reduce((sum, cluster) => sum + cluster.members.length, 0)).toBe(
      POSTS.length,
    );
  });

  test("lineage descriptor terms group identical topics verbatim", () => {
    const term = (label: string) => [
      { label, normalized: label.toLowerCase(), score: 10 },
    ];
    const clusters = clusterTopicTerms(
      ["a", "b", "c"],
      (id) => (id === "c" ? term("Other") : term("Founder systems")),
    );
    const founder = clusters.find((cluster) => cluster.label === "Founder systems");
    expect(founder?.members).toEqual(["a", "b"]);
    expect(clusters.find((cluster) => cluster.label === "Other")?.members).toEqual(["c"]);
  });

  test("specific multiword phrases outrank high-coverage unigrams", () => {
    const posts = [
      "Stop hiring a LinkedIn ghostwriter if you don't have a voice yet.",
      "Your LinkedIn profile can kill a sale before your content gets a chance.",
    ];
    const clusters = clusterTopicTerms(posts, (post) =>
      extractTopicCandidates(post),
    );
    const labels = clusters.map((cluster) => cluster.label);
    expect(labels).toContain("LinkedIn ghostwriter");
    // "LinkedIn" alone never swallows the specific phrases.
    expect(clusters.find((cluster) => cluster.label === "LinkedIn")).toBeUndefined();
  });
});
