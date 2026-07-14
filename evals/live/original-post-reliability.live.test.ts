import { describe, expect, test } from "vitest";
import type { AgentEvent, Artifact } from "@/lib/agent/contracts";
import { runAgent } from "@/lib/agent";
import { renderNoModelFormatBlock, selectNoModelFormatForTurn } from "@/lib/agent/no-model-formats";
import { loadVoiceProfile } from "@/lib/agent/tools";

const PROMPT =
  "Write an original post in my voice about how building a personal brand is the biggest leverage you can build for your career. Choose a proven framework that fits the topic, but do not model it after one specific source post.";

const workspaceId = process.env.LIVE_EVAL_WORKSPACE_ID ?? "";
const canRun = process.env.RUN_LIVE_EVALS === "1" && Boolean(process.env.OPENROUTER_API_KEY) && Boolean(workspaceId);
const maybe = canRun ? describe : describe.skip;

maybe("original-post reliability (live)", () => {
  test("the exact failed prompt delivers a draft without a get_voice-only round", async () => {
    const voice = await loadVoiceProfile(workspaceId);
    expect(voice.ok).toBe(true);

    const format = selectNoModelFormatForTurn(PROMPT);
    const events: AgentEvent[] = [];
    const startedAt = Date.now();
    for await (const event of runAgent({
      history: [{ role: "user", content: PROMPT }],
      workspaceId,
      userInstruction: PROMPT,
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      preloadedVoiceResult: voice,
      noModelFormatBlock: renderNoModelFormatBlock(format, []),
    })) {
      events.push(event);
    }
    const durationMs = Date.now() - startedAt;

    const artifacts = events
      .filter((event): event is Extract<AgentEvent, { type: "artifact" }> => event.type === "artifact")
      .map((event) => event.artifact)
      .filter((artifact): artifact is Artifact => artifact.kind === "post");
    const done = events.find((event): event is Extract<AgentEvent, { type: "done" }> => event.type === "done");
    const toolNames = (done?.message.tool_calls ?? []).map((call) => call.function.name);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].body.trim().length).toBeGreaterThan(100);
    expect(toolNames).toContain("render_post");
    expect(toolNames).not.toContain("get_voice");
    expect(done?.message.content).not.toContain("Stopped before a response was produced.");
    expect(durationMs).toBeLessThan(75_000);
  }, 90_000);
});
