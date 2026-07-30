import { describe, expect, it } from "vitest";
import {
  agentIdeaFingerprint,
  citeEvidenceByName,
} from "@/lib/agent-inbox/synthesis";
import type { AgentInboxEvidence } from "@/lib/agent-inbox";

describe("Agent inbox synthesis identity", () => {
  it("normalizes case so cosmetic variations cannot bypass deduplication", () => {
    expect(
      agentIdeaFingerprint("A Better Hook", "Use proof first", "source-1"),
    ).toBe(
      agentIdeaFingerprint("a better hook", "use proof first", "source-1"),
    );
  });

  it("changes when the underlying direction changes", () => {
    expect(
      agentIdeaFingerprint("A Better Hook", "Use proof first", "source-1"),
    ).not.toBe(
      agentIdeaFingerprint("A Better Hook", "Use story first", "source-1"),
    );
  });
});

describe("citeEvidenceByName", () => {
  const evidence = new Map<string, AgentInboxEvidence>([
    [
      "N1",
      {
        kind: "news",
        label: "The LinkedIn Playbook Every Executive Needs in 2026",
        detail: "Buyers increasingly evaluate leaders online before engaging.",
      },
    ],
    [
      "K7",
      {
        kind: "knowledge",
        label: "Story structure needs a defense beat",
        detail: "A pivot lands when the original decision is defended first.",
      },
    ],
  ]);

  it("replaces opaque evidence IDs with the source title", () => {
    expect(
      citeEvidenceByName("N1 says buyers check profiles first.", evidence),
    ).toBe(
      "“The LinkedIn Playbook Every Executive Needs in 2026” says buyers check profiles first.",
    );
  });

  it("rewrites multiple IDs in one bullet", () => {
    expect(
      citeEvidenceByName("N1 and K7 support leading with tension.", evidence),
    ).toBe(
      "“The LinkedIn Playbook Every Executive Needs in 2026” and “Story structure needs a defense beat” support leading with tension.",
    );
  });

  it("leaves unknown IDs and plain prose untouched", () => {
    expect(citeEvidenceByName("R99 is not indexed.", evidence)).toBe(
      "R99 is not indexed.",
    );
    expect(
      citeEvidenceByName("Profiles convert before content.", evidence),
    ).toBe("Profiles convert before content.");
  });
});
