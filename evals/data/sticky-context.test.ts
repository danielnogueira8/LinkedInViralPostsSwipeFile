import { describe, expect, test } from "vitest";
import {
  chatContextPolicyToolCall,
  recoverLatestForcedNoModelFormatId,
  recoverLatestSelection,
  rowsAfterLatestContextClear,
} from "@/lib/agent/turn/sticky-context";
import { NO_MODEL_FORMAT_CATALOG } from "@/lib/agent/no-model-format-catalog";
import {
  customSkillsToolCall,
  customSkillSelectionMarkerFromToolCalls,
} from "@/lib/agent/chat-turn";

// ---------------------------------------------------------------------------
// Explicit chat-context recovery: when a client opts into inheritance, recover
// the newest selection without crossing a changed selection or clear marker.
// ---------------------------------------------------------------------------

type Marker<T> =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "unfrozen" }
  | { kind: "valid"; context: T };

// A tiny fake: each row carries a pre-parsed marker under `m`, so the test drives
// the walk directly without the real chat-turn parsers.
function row(role: string, m: Marker<string> = { kind: "none" }) {
  return { role, m };
}
const parse = (r: { m: Marker<string> }) => r.m;

describe("recoverLatestSelection", () => {
  test("returns null when no row carries a selection", () => {
    expect(recoverLatestSelection([], parse)).toBeNull();
    expect(
      recoverLatestSelection([row("user"), row("assistant")], parse),
    ).toBeNull();
  });

  test("recovers a selection applied on an earlier turn", () => {
    expect(
      recoverLatestSelection(
        [
          row("user", { kind: "valid", context: "skill-A" }),
          row("assistant"),
          row("user"), // a later plain follow-up with no selection
        ],
        parse,
      ),
    ).toBe("skill-A");
  });

  test("the NEWEST selection wins over an older one", () => {
    expect(
      recoverLatestSelection(
        [
          row("user", { kind: "valid", context: "old" }),
          row("assistant"),
          row("user", { kind: "valid", context: "new" }),
        ],
        parse,
      ),
    ).toBe("new");
  });

  test("only USER rows carry a selection (assistant/tool rows are skipped)", () => {
    expect(
      recoverLatestSelection(
        [
          row("user", { kind: "valid", context: "skill-A" }),
          // An assistant row that (hypothetically) parsed to valid must NOT win.
          row("assistant", { kind: "valid", context: "assistant-noise" }),
        ],
        parse,
      ),
    ).toBe("skill-A");
  });

  test("stops at the latest bearing row even if its marker is non-reusable", () => {
    // The user's most recent turn changed skills into an invalid/legacy shape:
    // do NOT reach past it to revive an older frozen selection.
    expect(
      recoverLatestSelection(
        [
          row("user", { kind: "valid", context: "old" }),
          row("assistant"),
          row("user", { kind: "invalid" }),
        ],
        parse,
      ),
    ).toBeNull();
    expect(
      recoverLatestSelection(
        [
          row("user", { kind: "valid", context: "old" }),
          row("user", { kind: "unfrozen" }),
        ],
        parse,
      ),
    ).toBeNull();
  });
});

describe("recoverLatestSelection with the real custom-skill parser (wiring)", () => {
  // Proves the end-to-end path: a persisted user row carrying a real
  // applied_skills marker is recovered with its FULL frozen bodies, exactly as
  // setup.ts wires it — no DB re-fetch needed.
  test("recovers frozen skill bodies from a persisted applied_skills row", () => {
    const skill = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "cta",
      body: "CUSTOM_SKILL_RETRY_SENTINEL: end with one practical next step.",
    };
    const skillRow = {
      role: "user",
      applied_skills: { names: [skill.name], retryContext: { version: 1, skills: [skill] } },
      tool_calls: null,
    };
    const rows = [
      skillRow,
      { role: "assistant", applied_skills: undefined, tool_calls: null },
      { role: "user", applied_skills: undefined, tool_calls: null },
    ];

    const recovered = recoverLatestSelection(
      rows,
      customSkillSelectionMarkerFromToolCalls,
    );
    expect(recovered).toEqual({ version: 1, skills: [skill] });
    // The recovered ids are what setup.ts assigns to skillIds.
    expect(recovered?.skills.map((s) => s.id)).toEqual([skill.id]);
  });

  test("recovers from a _custom_skills_applied tool-call marker too", () => {
    const skill = {
      id: "44444444-4444-4444-8444-444444444444",
      name: "hook",
      body: "Open with a bold one-liner.",
    };
    const marker = customSkillsToolCall([skill.name], { version: 1, skills: [skill] });
    const rows = [
      { role: "user", tool_calls: [marker] },
      { role: "user", tool_calls: null },
    ];
    const recovered = recoverLatestSelection(
      rows,
      customSkillSelectionMarkerFromToolCalls,
    );
    expect(recovered?.skills).toEqual([skill]);
  });
});

describe("recoverLatestForcedNoModelFormatId", () => {
  const formatId = NO_MODEL_FORMAT_CATALOG[0].id;

  function fmtRow(role: string, no_model_format_id: string | null = null) {
    return { role, no_model_format_id };
  }

  test("recovers a forced format id stored on an earlier user turn", () => {
    expect(
      recoverLatestForcedNoModelFormatId([
        fmtRow("user", formatId),
        fmtRow("assistant"),
        fmtRow("user"), // a later plain follow-up
      ]),
    ).toBe(formatId);
  });

  test("returns null when no user row stored a format", () => {
    expect(recoverLatestForcedNoModelFormatId([])).toBeNull();
    expect(
      recoverLatestForcedNoModelFormatId([fmtRow("user"), fmtRow("assistant")]),
    ).toBeNull();
  });

  test("an unknown stored id (retired format) is not revived", () => {
    expect(
      recoverLatestForcedNoModelFormatId([fmtRow("user", "not-a-real-format")]),
    ).toBeNull();
  });

  test("ignores a format id stored on a non-user row", () => {
    expect(
      recoverLatestForcedNoModelFormatId([fmtRow("assistant", formatId)]),
    ).toBeNull();
  });
});

describe("explicit chat-context clears", () => {
  test("a clear tombstone prevents older context from being revived", () => {
    const rows = [
      { role: "user", tool_calls: null, value: "old" },
      {
        role: "user",
        tool_calls: [chatContextPolicyToolCall({ clear: ["skills"] })],
        value: null,
      },
      { role: "user", tool_calls: null, value: null },
    ];

    const scoped = rowsAfterLatestContextClear(rows, "skills");
    expect(scoped).toEqual(rows.slice(1));
    expect(scoped.some((item) => item.value === "old")).toBe(false);
  });

  test("clearing one context kind does not clear the others", () => {
    const rows = [
      { role: "user", tool_calls: null },
      {
        role: "user",
        tool_calls: [chatContextPolicyToolCall({ clear: ["skills"] })],
      },
    ];

    expect(rowsAfterLatestContextClear(rows, "creator_style")).toEqual(rows);
  });
});
