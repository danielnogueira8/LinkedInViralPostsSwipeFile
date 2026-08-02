import { describe, expect, it } from "vitest";
import {
  areDistinctOpportunityAngles,
  collectDistinctRefinedOpportunities,
  isStrongOpportunity,
  readModelOpportunityQuality,
  scoreOpportunityQuality,
  topicRelevance,
} from "@/lib/agent-inbox/opportunity-quality";

const strongModel = {
  relevance: 0.9,
  tension: 0.85,
  novelty: 0.8,
  timeliness: 0.75,
  shareability: 0.85,
};

describe("opportunity quality", () => {
  it("ranks a relevant, tense, well-supported idea above a generic one", () => {
    const strong = scoreOpportunityQuality({
      model: strongModel,
      evidence: 0.9,
      topicFit: 1,
    });
    const generic = scoreOpportunityQuality({
      model: {
        relevance: 0.55,
        tension: 0.2,
        novelty: 0.25,
        timeliness: 0.4,
        shareability: 0.25,
      },
      evidence: 0.9,
      topicFit: 0.4,
    });
    expect(strong.score).toBeGreaterThan(generic.score);
    expect(isStrongOpportunity(strong)).toBe(true);
    expect(isStrongOpportunity(generic)).toBe(false);
  });

  it("keeps evidence as a hard quality gate", () => {
    const unsupported = scoreOpportunityQuality({
      model: strongModel,
      evidence: 0.3,
      topicFit: 1,
    });
    expect(isStrongOpportunity(unsupported)).toBe(false);
  });

  it("uses preferred-topic overlap as an independent relevance signal", () => {
    expect(
      topicRelevance(
        ["founder-led sales", "LinkedIn writing"],
        "Why founder-led sales posts fail on LinkedIn",
      ),
    ).toBeGreaterThan(topicRelevance(["founder-led sales"], "Office plants"));
  });

  it("rejects incomplete model judgments", () => {
    expect(readModelOpportunityQuality({ relevance: 0.8 })).toBeNull();
    expect(readModelOpportunityQuality(strongModel)).toEqual(strongModel);
  });

  it("does not count punctuation or headline-only changes as distinct angles", () => {
    expect(
      areDistinctOpportunityAngles(
        "Teams add agent graphs before proving the underlying task deserves an agent.",
        "Teams add agent graphs before proving the underlying task deserves an agent!",
      ),
    ).toBe(false);
    expect(
      areDistinctOpportunityAngles(
        "Teams add agent graphs before proving the underlying task deserves an agent.",
        "The real shift is that creators now need evidence only they can substantiate.",
      ),
    ).toBe(true);
  });

  it("selects the strongest proposal before removing near duplicates", () => {
    const result = collectDistinctRefinedOpportunities({
      candidates: new Map([["candidate-1", {}]]),
      rows: [
        {
          candidate_id: "candidate-1",
          headline: "Mediocre version",
          thesis:
            "Teams add agent graphs before proving the task deserves an agent.",
          viral_mechanism: "Names a common mistake.",
          quality: 0.7,
        },
        {
          candidate_id: "candidate-1",
          headline: "Strong version",
          thesis:
            "Teams add agent graphs before proving the task deserves an agent!",
          viral_mechanism: "Names an expensive mistake.",
          quality: 0.9,
        },
        {
          candidate_id: "candidate-1",
          headline: "Distinct version",
          thesis:
            "The winning workflow starts by measuring the human handoff cost.",
          viral_mechanism: "Offers a useful decision rule.",
          quality: 0.8,
        },
      ],
      qualityFor: ({ model }) => ({
        score: Number(model),
        dimensions: {
          relevance: 0.8,
          tension: 0.8,
          evidence: 0.8,
          novelty: 0.8,
          timeliness: 0.8,
          shareability: 0.8,
        },
      }),
    });
    expect(result.get("candidate-1")?.headline).toBe("Strong version");
  });
});
