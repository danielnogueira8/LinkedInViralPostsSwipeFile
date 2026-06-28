// Types for the deterministic stub of OpenRouter `streamChat`. The runtime
// lives in run-agent-test.ts (it needs persistent round-counter state across
// the multiple streamChat() calls a single agent turn makes — one per round).

// One round's worth of model output.
export type StubRound = {
  // Optional text the model emits (one chunk, no token-by-token simulation).
  text?: string;
  // Tool calls the model emits this round. Each becomes a tool_calls delta
  // with id/name/argumentsFragment. Empty array = no tool calls (treated as
  // a candidate final answer by the loop).
  toolCalls?: Array<{
    id?: string;
    name: string;
    // Pass args as an object — the stub JSON-stringifies. Pass a string to
    // simulate the model emitting malformed JSON for the args.
    args: Record<string, unknown> | string;
  }>;
  // Finish reason for this round. "stop" means no more tool calls — the loop
  // treats this as the final answer. "tool_calls" means more rounds coming.
  // "length" simulates a length-cutoff; "content_filter" simulates the safety
  // filter blocking the generation. Default: "tool_calls" if there are tool
  // calls, otherwise "stop".
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter";
  // Optional usage stats for token accounting in tests.
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  // If set, the stub throws this error instead of yielding the round —
  // used to simulate provider errors (rate-limit, content-filter, etc.) the
  // agent loop's catch should handle.
  throws?: { message: string; code?: string | number };
};

// A script controls one whole agent turn's behavior. The stub plays rounds in
// order; if streamChat is called more times than rounds in the script, the
// stub yields an empty "stop" round (simulating the model finishing naturally).
export type StubScript = {
  rounds: StubRound[];
};
