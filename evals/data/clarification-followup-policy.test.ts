import { describe, expect, test } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";
import {
  clarificationFollowupInstruction,
  hasPendingAskOnly,
  hasPendingActionAsk,
  hasUnsavedAssistantDraftReferent,
  prepareClarificationTurn,
  validatePendingActionAnswer,
} from "@/lib/agent/turn-policy";
import { isNoModelPostRequest } from "@/lib/agent/no-model-formats";
import { requestsDirectSourceModeling } from "@/lib/agent/source-policy";

const askCall = {
  id: "ask-1",
  type: "function" as const,
  function: {
    name: "ask_user",
    arguments: JSON.stringify({
      question: "What topic should the post cover?",
      options: ["AI workflows", "Personal branding"],
    }),
  },
};

describe("clarification follow-up policy", () => {
  test("keeps a recent unsaved draft referent across intervening text turns", () => {
    expect(
      hasUnsavedAssistantDraftReferent([
        { role: "assistant", artifacts: null },
        { role: "user", artifacts: null },
        {
          role: "assistant",
          artifacts: [
            {
              id: "preview",
              kind: "post",
              title: "Unsaved",
              body: "Draft body",
            },
          ],
        },
      ]),
    ).toBe(true);
  });

  test("recognizes the latest draft as saved after Save draft stores its board id", () => {
    expect(
      hasUnsavedAssistantDraftReferent([
        {
          role: "assistant",
          artifacts: [
            {
              id: "saved-preview",
              kind: "post",
              title: "Saved",
              body: "Draft body",
              meta: {
                board_draft_id: "00000000-0000-4000-8000-000000000710",
              },
            },
          ],
        },
        {
          role: "assistant",
          artifacts: [
            {
              id: "older-unsaved-preview",
              kind: "post",
              title: "Older unsaved",
              body: "Older body",
            },
          ],
        },
      ]),
    ).toBe(false);
  });

  test("finds a persisted ask behind newer tool rows for cost reservation", () => {
    expect(
      hasPendingAskOnly([
        { role: "tool" },
        { role: "assistant", tool_calls: [askCall] },
        { role: "user" },
      ]),
    ).toBe(true);
    expect(
      hasPendingAskOnly([
        { role: "tool" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "render-1",
              type: "function",
              function: { name: "render_post", arguments: "{}" },
            },
            askCall,
          ],
        },
      ]),
    ).toBe(false);
  });

  test("distinguishes an action-lane ask from an ordinary clarification", () => {
    const actionAsk = {
      ...askCall,
      function: {
        ...askCall.function,
        arguments: JSON.stringify({
          question: "What date should I plan this draft for?",
          options: ["Today", "Tomorrow"],
          actionLane: true,
        }),
      },
    };
    expect(
      hasPendingActionAsk([
        { role: "tool" },
        { role: "assistant", tool_calls: [actionAsk] },
      ]),
    ).toBe(true);
    expect(
      hasPendingActionAsk([{ role: "assistant", tool_calls: [askCall] }]),
    ).toBe(false);
  });

  test("requires an exact persisted target selection before an action turn is claimed", () => {
    const actionAsk = {
      ...askCall,
      function: {
        ...askCall.function,
        arguments: JSON.stringify({
          question: "Which 2 saved drafts did you mean?",
          options: ["Pricing", "Hiring", "Leadership"],
          candidateDraftIds: [
            "00000000-0000-4000-8000-000000000701",
            "00000000-0000-4000-8000-000000000702",
            "00000000-0000-4000-8000-000000000703",
          ],
          actionLane: true,
          multiSelect: true,
          targetCount: 2,
          allowOther: false,
        }),
      },
    };
    const messages = [{ role: "assistant" as const, tool_calls: [actionAsk] }];
    expect(
      validatePendingActionAnswer(messages, "Pricing; Hiring", [
        "00000000-0000-4000-8000-000000000701",
        "00000000-0000-4000-8000-000000000702",
      ]),
    ).toEqual({
      ok: true,
      selectedTargetIds: [
        "00000000-0000-4000-8000-000000000701",
        "00000000-0000-4000-8000-000000000702",
      ],
    });
    expect(
      validatePendingActionAnswer(messages, "Pricing", [
        "00000000-0000-4000-8000-000000000701",
      ]),
    ).toEqual({
      ok: false,
      expected: 2,
    });
    expect(
      validatePendingActionAnswer(messages, "Pricing; Hiring; Leadership", [
        "00000000-0000-4000-8000-000000000701",
        "00000000-0000-4000-8000-000000000702",
        "00000000-0000-4000-8000-000000000703",
      ]),
    ).toEqual({ ok: false, expected: 2 });
    expect(
      validatePendingActionAnswer(messages, "Pricing; Unknown", [
        "00000000-0000-4000-8000-000000000701",
        "00000000-0000-4000-8000-000000000799",
      ]),
    ).toEqual({ ok: false, expected: 2 });
    expect(validatePendingActionAnswer(messages, "Never mind")).toEqual({
      ok: true,
      cancelled: true,
    });
  });

  test("a saved draft titled Stop is selected by id instead of cancelling the action", () => {
    const stopId = "00000000-0000-4000-8000-000000000701";
    const actionAsk = {
      ...askCall,
      function: {
        ...askCall.function,
        arguments: JSON.stringify({
          question: "Which saved draft did you mean?",
          options: ["Stop", "Pricing"],
          candidateDraftIds: [
            stopId,
            "00000000-0000-4000-8000-000000000702",
          ],
          actionLane: true,
          allowOther: false,
        }),
      },
    };

    expect(
      validatePendingActionAnswer(
        [{ role: "assistant", tool_calls: [actionAsk] }],
        "Stop",
        [stopId],
      ),
    ).toEqual({ ok: true, selectedTargetIds: [stopId] });
  });

  test("reconstructs a persisted AskCard before protocol sanitization drops its unmatched tool call", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Help me write a LinkedIn post." },
      {
        role: "assistant",
        content: "What should the post be about?",
        tool_calls: [askCall],
      },
      { role: "user", content: "An AI-assisted content workflow post" },
    ];

    const prepared = prepareClarificationTurn(
      history,
      "An AI-assisted content workflow post",
    );

    expect(prepared.effectiveUserInstruction).toBe(
      "Help me write a LinkedIn post.\n\nClarification answer: An AI-assisted content workflow post",
    );
    expect(prepared.history[1]).toEqual({
      role: "assistant",
      content: "What should the post be about?",
    });
  });

  test("carries the original post request into a topic answer", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Help me write a LinkedIn post." },
      {
        role: "assistant",
        content: "What topic should the post cover?",
        tool_calls: [askCall],
      },
      { role: "tool", tool_call_id: "ask-1", content: '{"asked":true}' },
      { role: "user", content: "An AI-assisted content workflow post" },
    ];

    const effective = clarificationFollowupInstruction(
        history,
        "An AI-assisted content workflow post",
      );
    expect(effective).toBe(
      "Help me write a LinkedIn post.\n\nClarification answer: An AI-assisted content workflow post",
    );
    expect(isNoModelPostRequest(effective, false)).toBe(true);
  });

  test("preserves an explicit source request through clarification", () => {
    const history: ChatMessage[] = [
      {
        role: "user",
        content:
          "Find one top-performing post in my swipe file and model it into a post about [topic].",
      },
      {
        role: "assistant",
        content: "Which topic should I use?",
        tool_calls: [askCall],
      },
      { role: "tool", tool_call_id: "ask-1", content: '{"asked":true}' },
      { role: "user", content: "Founder-led distribution" },
    ];

    const effective = clarificationFollowupInstruction(
      history,
      "Founder-led distribution",
    );
    expect(effective).toContain("Find one top-performing post in my swipe file");
    expect(requestsDirectSourceModeling(effective)).toBe(true);
  });

  test("does not reinterpret an after-draft edit choice as a new post request", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Write a post about founder-led distribution." },
      {
        role: "assistant",
        content: "What would you like to do next?",
        tool_calls: [
          {
            id: "render-1",
            type: "function",
            function: {
              name: "render_post",
              arguments: '{"body":"Draft"}',
            },
          },
          askCall,
        ],
      },
      { role: "tool", tool_call_id: "render-1", content: '{"ok":true}' },
      { role: "tool", tool_call_id: "ask-1", content: '{"asked":true}' },
      { role: "user", content: "Make it shorter" },
    ];

    expect(clarificationFollowupInstruction(history, "Make it shorter")).toBe(
      "Make it shorter",
    );
  });
});
