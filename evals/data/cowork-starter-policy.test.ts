import { describe, expect, test } from "vitest";
import {
  COWORK_ALTERNATIVE_STARTER_IDS,
  COWORK_PRIMARY_STARTER_ID,
  partitionCoworkStarters,
} from "@/lib/cowork-starter-policy";

const starters = [
  { id: "brainstorm", label: "Brainstorm new post ideas" },
  { id: "model-top-viral", label: "Model a top viral post" },
  { id: "model-recent-lead-magnet", label: "Model a recent viral lead magnet" },
  { id: "working-this-week", label: "What's working this week" },
  { id: "write-original", label: "Write an original post" },
  { id: "namejack", label: "Namejack a person" },
  { id: "brandjack", label: "Brandjack a company" },
  { id: "newsjack", label: "Newsjack a recent event" },
  { id: "series", label: "Turn one idea into a series" },
];

describe("Cowork starter disclosure policy", () => {
  test("keeps one recommended start and two visible alternatives", () => {
    const layout = partitionCoworkStarters(starters);

    expect(layout.primary.id).toBe(COWORK_PRIMARY_STARTER_ID);
    expect(layout.alternatives.map((starter) => starter.id)).toEqual(
      COWORK_ALTERNATIVE_STARTER_IDS,
    );
  });

  test("keeps every remaining workflow available exactly once", () => {
    const layout = partitionCoworkStarters(starters);
    const visibleIds = [
      layout.primary.id,
      ...layout.alternatives.map((starter) => starter.id),
      ...layout.library.map((starter) => starter.id),
    ];

    expect(visibleIds).toHaveLength(starters.length);
    expect(new Set(visibleIds)).toEqual(new Set(starters.map((starter) => starter.id)));
    expect(layout.library.map((starter) => starter.label)).toContain(
      "Namejack a person",
    );
    expect(layout.library.map((starter) => starter.label)).toContain(
      "Brandjack a company",
    );
  });

  test("uses stable IDs so display-copy changes do not alter the policy", () => {
    const renamed = starters.map((starter) =>
      starter.id === COWORK_PRIMARY_STARTER_ID
        ? { ...starter, label: "Create a post" }
        : starter,
    );

    expect(partitionCoworkStarters(renamed).primary.label).toBe("Create a post");
  });

  test("fails loudly if the recommended workflow is removed", () => {
    expect(() =>
      partitionCoworkStarters([{ id: "brainstorm" }]),
    ).toThrow(/write-original/);
  });
});
