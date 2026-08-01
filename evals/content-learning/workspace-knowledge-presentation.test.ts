import { describe, expect, test } from "vitest";
import type { WorkspaceKnowledgeItem } from "@/lib/content-learning/contracts";
import { workspaceKnowledgeDisplayText } from "@/lib/content-learning/workspace-knowledge-presentation";

const timestamp = "2026-07-30T14:00:00.000Z";

function item(
  overrides: Partial<WorkspaceKnowledgeItem>,
): WorkspaceKnowledgeItem {
  return {
    schemaVersion: 1,
    id: "knowledge-1",
    workspaceId: "workspace-1",
    kind: "topic_expertise",
    title: "The three-step process",
    content: {
      topic: "The three-step process",
      basis: "I ask Claude for hook angles, improve readability, and verify every fact.",
    },
    source: "interview",
    sourceRef: "workspace-1:chat-interview:answer",
    confidence: 1,
    verification: "proposed",
    lastVerifiedAt: null,
    active: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  } as WorkspaceKnowledgeItem;
}

describe("Workspace Knowledge review presentation", () => {
  test("shows the complete topic answer rather than its short topic label", () => {
    expect(workspaceKnowledgeDisplayText(item({}))).toBe(
      "I ask Claude for hook angles, improve readability, and verify every fact.",
    );
  });

  test("includes stored detail fields when a knowledge item has them", () => {
    expect(
      workspaceKnowledgeDisplayText(
        item({
          kind: "story",
          title: "A defining moment",
          content: {
            summary: "We nearly lost the account.",
            details: "I rebuilt the plan around the customer's words and won it back.",
          },
        }),
      ),
    ).toBe(
      "We nearly lost the account.\n\nI rebuilt the plan around the customer's words and won it back.",
    );
  });
});
