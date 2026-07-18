import type { ModelingClientContext } from "@/lib/modeling-source-selection";

const MAX_FIELD_CHARS = 2_000;
const MAX_VALUES = 32;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const bounded = value.slice(0, MAX_FIELD_CHARS);
  return bounded.length > 0 ? bounded : undefined;
}

function boundedStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .slice(0, MAX_VALUES)
    .map(boundedString)
    .filter((entry): entry is string => entry !== undefined);
}

/**
 * Converts the broad voice-tool result into the only client attributes source
 * selection may inspect. This boundary deliberately excludes style rules,
 * exemplars, mechanics, backstory, and arbitrary future profile fields.
 */
export function modelingSelectionContext(
  userInstruction: unknown,
  voiceResult: unknown,
): ModelingClientContext {
  const instruction = boundedString(userInstruction);
  const context: ModelingClientContext = {
    ...(instruction ? { userInstruction: instruction } : {}),
  };
  const result = recordOf(voiceResult);
  if (result?.ok !== true) return context;
  const voice = recordOf(result.voice);
  if (!voice) return context;
  const profile = recordOf(voice.profile);
  const audience = recordOf(profile?.audience);
  const identity = [voice.headline, voice.summary]
    .map(boundedString)
    .filter((entry): entry is string => entry !== undefined);
  const topics = boundedStrings(profile?.topics);
  const positioning = boundedStrings(profile?.positioning);
  const audienceValues = boundedStrings(audience?.primary);
  const painPoints = boundedStrings(audience?.pain_points);
  const outcomes = boundedStrings(audience?.outcomes);
  if (
    identity.length === 0 &&
    topics.length === 0 &&
    positioning.length === 0 &&
    audienceValues.length === 0 &&
    painPoints.length === 0 &&
    outcomes.length === 0
  ) {
    return context;
  }
  return {
    ...context,
    voiceAnchors: {
      ...(identity.length ? { identity } : {}),
      ...(topics.length ? { topics } : {}),
      ...(positioning.length ? { positioning } : {}),
      ...(audienceValues.length ? { audience: audienceValues } : {}),
      ...(painPoints.length ? { painPoints } : {}),
      ...(outcomes.length ? { outcomes } : {}),
    },
  };
}
