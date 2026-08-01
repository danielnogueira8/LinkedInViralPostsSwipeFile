import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const knowledgePage = readFileSync(
  "app/(app)/dashboard/knowledge/page.tsx",
  "utf8",
);
const knowledgeWorkspace = readFileSync(
  "app/(app)/dashboard/knowledge/knowledge-workspace.tsx",
  "utf8",
);
const interview = readFileSync(
  "app/(app)/dashboard/knowledge/context-interview-card.tsx",
  "utf8",
);
const voicePage = readFileSync(
  "app/(app)/dashboard/voice/page.tsx",
  "utf8",
);
const voiceWorkspace = readFileSync(
  "app/(app)/dashboard/voice/workspace.tsx",
  "utf8",
);
const voiceManager = readFileSync(
  "app/(app)/dashboard/voice/manager.tsx",
  "utf8",
);

describe("Knowledge context interview ownership", () => {
  test("loads and renders the interview with its review queue in Knowledge", () => {
    expect(knowledgePage).toContain("interviewKnowledgeSourcePrefix");
    expect(knowledgePage).toContain("<KnowledgeWorkspace");
    expect(knowledgeWorkspace).toContain("<ContextInterviewCard");
    expect(knowledgeWorkspace).toContain("<InterviewKnowledgeReview");
  });

  test("removes interview controls and duplicated context editing from Voice", () => {
    expect(voicePage).not.toContain("interviewKnowledgeSourcePrefix");
    expect(voiceWorkspace).not.toContain("VoiceInterviewCard");
    expect(voiceWorkspace).not.toContain("KnowledgeReview");
    expect(voiceManager).not.toContain('title="Interview context"');
  });

  test("keeps desktop scrolling independent without nested mobile scrolling", () => {
    expect(interview).toContain('data-testid="context-interview-scroll"');
    expect(interview).toContain("lg:max-h-[calc(100dvh-8rem)]");
    expect(interview).toContain("lg:overflow-y-auto");
    expect(interview).not.toMatch(/(?<!lg:)overflow-y-auto/);
  });
});
