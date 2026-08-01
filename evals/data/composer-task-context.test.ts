import { describe, expect, test } from "vitest";
import {
  composerStarterMarkerFromToolCalls,
  composerStarterToolCall,
  resolveComposerTaskContext,
} from "@/lib/composer-task-context";

describe("resolveComposerTaskContext", () => {
  test("makes the original-post starter and selected count authoritative", () => {
    expect(
      resolveComposerTaskContext({
        starterId: "write-original",
        selectedDraftCount: 2,
        fallbackPostCount: 1,
      }),
    ).toEqual({
      kind: "post",
      expectedDraftCount: 2,
      sourceMode: "original",
      starterId: "write-original",
    });
  });

  test("treats the series starter as an original-post task with no research lane", () => {
    expect(
      resolveComposerTaskContext({
        starterId: "series",
        selectedDraftCount: 3,
        fallbackPostCount: null,
      }),
    ).toEqual({
      kind: "post",
      expectedDraftCount: 3,
      sourceMode: "original",
      starterId: "series",
    });
  });

  test("defaults the series starter to 3 drafts when nothing else sets a count", () => {
    // Regression: the message-count parser doesn't read "3-part" as a number,
    // so without a starter default the turn collapsed to ONE draft with all
    // three parts crammed in.
    expect(
      resolveComposerTaskContext({
        starterId: "series",
        fallbackPostCount: null,
      }),
    ).toEqual({
      kind: "post",
      expectedDraftCount: 3,
      sourceMode: "original",
      starterId: "series",
    });
  });

  test("keeps UI and message counts ahead of the series starter default", () => {
    expect(
      resolveComposerTaskContext({
        starterId: "series",
        selectedDraftCount: 2,
        fallbackPostCount: null,
      }).expectedDraftCount,
    ).toBe(2);
    expect(
      resolveComposerTaskContext({
        starterId: "series",
        fallbackPostCount: 5,
        explicitMessagePostCount: 5,
      }).expectedDraftCount,
    ).toBe(5);
  });

  test("does not let the parser's implicit single post beat the series default", () => {
    // Production regression: requestedBasePostCount returns an IMPLICIT 1 for
    // any post request whose count it cannot parse ("3-part" is not a number),
    // and that 1 used to win over the starter default — collapsing the series
    // to ONE draft with all parts crammed in.
    expect(
      resolveComposerTaskContext({
        starterId: "series",
        fallbackPostCount: 1,
        explicitMessagePostCount: null,
      }).expectedDraftCount,
    ).toBe(3);
  });

  test("automatically treats an attached bookmark as the selected source", () => {
    expect(
      resolveComposerTaskContext({
        starterId: "write-original",
        selectedDraftCount: 3,
        selectedSourceId: "source-123",
        fallbackPostCount: null,
      }),
    ).toEqual({
      kind: "post",
      expectedDraftCount: 3,
      sourceMode: "selected",
      selectedSourceId: "source-123",
      starterId: "write-original",
    });
  });

  test("an attached source alone establishes a post task", () => {
    expect(
      resolveComposerTaskContext({
        selectedDraftCount: 2,
        selectedSourceId: "source-123",
        fallbackPostCount: null,
      }),
    ).toEqual({
      kind: "post",
      expectedDraftCount: 2,
      sourceMode: "selected",
      selectedSourceId: "source-123",
    });
  });

  test("does not turn a non-post starter into drafts merely because a count is selected", () => {
    expect(
      resolveComposerTaskContext({
        starterId: "working-this-week",
        selectedDraftCount: 5,
        fallbackPostCount: null,
      }),
    ).toEqual({
      kind: "answer",
      expectedDraftCount: null,
      sourceMode: "workspace_auto",
      starterId: "working-this-week",
      researchRequirement: {
        lane: "workspace",
        minimumSources: 1,
        searchMode: "strict_top",
        since: "7d",
        oneSourcePerDraft: false,
      },
    });
  });

  test("materializes source policy in the context instead of making routing know starter ids", () => {
    expect(
      resolveComposerTaskContext({
        starterId: "model-top-viral",
        selectedDraftCount: 3,
        fallbackPostCount: null,
      }),
    ).toMatchObject({
      kind: "post",
      expectedDraftCount: 3,
      sourceMode: "workspace_auto",
      researchRequirement: {
        lane: "workspace",
        minimumSources: 3,
        searchMode: "strict_top",
        postType: "regular",
        oneSourcePerDraft: true,
      },
    });
  });

  test("keeps the existing free-form classification only as a fallback", () => {
    expect(
      resolveComposerTaskContext({
        selectedDraftCount: 4,
        fallbackPostCount: 1,
      }),
    ).toEqual({
      kind: "post",
      expectedDraftCount: 4,
      sourceMode: "unspecified",
    });
    expect(
      resolveComposerTaskContext({
        selectedDraftCount: 4,
        fallbackPostCount: null,
      }),
    ).toEqual({
      kind: "answer",
      expectedDraftCount: null,
      sourceMode: "unspecified",
    });
  });

  test("the interview-me starter is an answer task with no research lane", () => {
    // The interview produces knowledge, not drafts: no post count, no source
    // requirement — even though the card sends the "ask" command.
    expect(
      resolveComposerTaskContext({
        starterId: "interview-me",
        commandKind: "ask",
        fallbackPostCount: 1,
      }),
    ).toEqual({
      kind: "answer",
      expectedDraftCount: null,
      sourceMode: "unspecified",
      starterId: "interview-me",
    });
  });
});

describe("composer starter persistence", () => {
  test("round-trips one strict server-owned marker", () => {
    expect(
      composerStarterMarkerFromToolCalls([
        composerStarterToolCall("write-original"),
      ]),
    ).toEqual({ kind: "valid", starterId: "write-original" });
  });

  test("rejects duplicate or forged markers instead of guessing", () => {
    const valid = composerStarterToolCall("write-original");
    expect(composerStarterMarkerFromToolCalls([valid, valid])).toEqual({
      kind: "invalid",
    });
    expect(
      composerStarterMarkerFromToolCalls([
        {
          ...valid,
          function: {
            ...valid.function,
            arguments: JSON.stringify({
              version: 1,
              starterId: "write-original",
              injected: true,
            }),
          },
        },
      ]),
    ).toEqual({ kind: "invalid" });
  });
});
