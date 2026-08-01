import { z } from "zod";
import {
  MODEL_SOURCE_SELECTION_POLICY,
  type ModelSourceSelectionPolicy,
} from "@/lib/agent/model-source-selection-policy";
import type { DraftCount } from "@/lib/generation-config";
import type { ToolCall } from "@/lib/openrouter";

const COMPOSER_STARTER_MARKER_ID = "_composer_starter_selected";

export const composerStarterIdSchema = z.enum([
  "brainstorm",
  "model-top-viral",
  "model-recent-lead-magnet",
  "working-this-week",
  "write-original",
  "namejack",
  "brandjack",
  "newsjack",
  "series",
  "interview-me",
]);

export type ComposerStarterId = z.infer<typeof composerStarterIdSchema>;

type ComposerTaskKind = "answer" | "ideas" | "post";
export type ComposerSourceMode =
  | "original"
  | "selected"
  | "workspace_auto"
  | "web_research"
  | "unspecified";

export type ComposerResearchRequirement =
  | {
      lane: "workspace";
      minimumSources: number;
      searchMode: "diverse" | "strict_top";
      since?: "1d" | "7d" | "30d";
      postType?: "regular" | "lead_magnet";
      oneSourcePerDraft: boolean;
    }
  | { lane: "web" | "news" };

type StarterResearchDefinition =
  | {
      lane: "workspace";
      minimumSources: number | "draft_count";
      searchMode: "diverse" | "strict_top";
      since?: "1d" | "7d" | "30d";
      postType?: "regular" | "lead_magnet";
      oneSourcePerDraft?: boolean;
    }
  | { lane: "web" | "news" };

type StarterTaskDefinition = {
  kind: ComposerTaskKind;
  sourceMode: ComposerSourceMode;
  research?: StarterResearchDefinition;
  sourceSelection?: ModelSourceSelectionPolicy;
  // Draft count the starter implies when neither the UI picker nor an explicit
  // message count settles it (e.g. a 3-part series is meaningless as 1 draft).
  defaultDraftCount?: number;
};

function materializeResearchRequirement(
  definition: StarterResearchDefinition | undefined,
  expectedDraftCount: number | null,
): ComposerResearchRequirement | undefined {
  if (!definition) return undefined;
  if (definition.lane !== "workspace") return definition;
  return {
    lane: definition.lane,
    minimumSources:
      definition.minimumSources === "draft_count"
        ? (expectedDraftCount ?? 1)
        : definition.minimumSources,
    searchMode: definition.searchMode,
    ...(definition.since ? { since: definition.since } : {}),
    ...(definition.postType ? { postType: definition.postType } : {}),
    oneSourcePerDraft:
      definition.oneSourcePerDraft === true &&
      expectedDraftCount !== null &&
      expectedDraftCount >= 1 &&
      expectedDraftCount <= 6,
  };
}

const STARTER_TASKS: Record<
  ComposerStarterId,
  StarterTaskDefinition
> = {
  brainstorm: {
    kind: "ideas",
    sourceMode: "workspace_auto",
    research: {
      lane: "workspace",
      minimumSources: 5,
      searchMode: "strict_top",
      since: "30d",
    },
  },
  "model-top-viral": {
    kind: "post",
    sourceMode: "workspace_auto",
    research: {
      lane: "workspace",
      minimumSources: "draft_count",
      searchMode: "strict_top",
      postType: "regular",
      oneSourcePerDraft: true,
    },
    sourceSelection: MODEL_SOURCE_SELECTION_POLICY,
  },
  "model-recent-lead-magnet": {
    kind: "post",
    sourceMode: "workspace_auto",
    research: {
      lane: "workspace",
      minimumSources: "draft_count",
      searchMode: "strict_top",
      since: "30d",
      postType: "lead_magnet",
      oneSourcePerDraft: true,
    },
    sourceSelection: MODEL_SOURCE_SELECTION_POLICY,
  },
  "working-this-week": {
    kind: "answer",
    sourceMode: "workspace_auto",
    research: {
      lane: "workspace",
      minimumSources: 1,
      searchMode: "strict_top",
      since: "7d",
    },
  },
  "write-original": { kind: "post", sourceMode: "original" },
  namejack: {
    kind: "post",
    sourceMode: "web_research",
    research: { lane: "web" },
  },
  brandjack: {
    kind: "post",
    sourceMode: "web_research",
    research: { lane: "web" },
  },
  newsjack: {
    kind: "post",
    sourceMode: "web_research",
    research: { lane: "news" },
  },
  // A series is built from the user's own idea, so it needs no research lane.
  // The count must come from the starter itself: the message-count parser
  // doesn't read "3-part" as a number, so without this the turn collapsed to
  // ONE draft with all parts crammed in.
  series: { kind: "post", sourceMode: "original", defaultDraftCount: 3 },
  // A conversation, not a generation: the agent interviews the user (see the
  // interview-me skill) and saves answers as proposed Workspace Knowledge.
  // No research lane, no drafts — the deliverable is knowledge.
  "interview-me": { kind: "answer", sourceMode: "unspecified" },
};

type ComposerTaskContextBase = {
  sourceMode: ComposerSourceMode;
  selectedSourceId?: string;
  starterId?: ComposerStarterId;
  researchRequirement?: ComposerResearchRequirement;
  sourceSelection?: ModelSourceSelectionPolicy;
};

export type ComposerTaskContext =
  | (ComposerTaskContextBase & {
      kind: "post";
      expectedDraftCount: number;
    })
  | (ComposerTaskContextBase & {
      kind: Exclude<ComposerTaskKind, "post">;
      expectedDraftCount: null;
    });

export type ComposerTaskSelection = {
  starterId?: ComposerStarterId;
  selectedDraftCount?: DraftCount;
  selectedSourceId?: string;
  commandKind?: "ask" | "create" | "edit";
};

export function composerStarterToolCall(
  starterId: ComposerStarterId,
): ToolCall {
  return {
    id: COMPOSER_STARTER_MARKER_ID,
    type: "function",
    function: {
      name: COMPOSER_STARTER_MARKER_ID,
      arguments: JSON.stringify({ version: 1, starterId }),
    },
  };
}

export type ComposerStarterMarker =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; starterId: ComposerStarterId };

export function composerStarterMarkerFromToolCalls(
  input:
    | ToolCall[] | null | undefined
    | {
        composer_starter_id?: string | null;
        tool_calls?: ToolCall[] | null | undefined;
      },
): ComposerStarterMarker {
  let calls: ToolCall[] | null | undefined;
  if (Array.isArray(input) || input === null || input === undefined) {
    calls = input;
  } else {
    if (
      typeof input.composer_starter_id === "string" &&
      input.composer_starter_id.trim()
    ) {
      const parsed = composerStarterIdSchema.safeParse(
        input.composer_starter_id.trim(),
      );
      return parsed.success
        ? { kind: "valid", starterId: parsed.data }
        : { kind: "invalid" };
    }
    calls = input.tool_calls;
  }
  const markers = (calls ?? []).filter(
    (call) =>
      call.id === COMPOSER_STARTER_MARKER_ID &&
      call.function.name === COMPOSER_STARTER_MARKER_ID,
  );
  if (markers.length === 0) return { kind: "none" };
  if (markers.length !== 1) return { kind: "invalid" };
  try {
    const parsed = z
      .object({
        version: z.literal(1),
        starterId: composerStarterIdSchema,
      })
      .strict()
      .safeParse(JSON.parse(markers[0].function.arguments));
    return parsed.success
      ? { kind: "valid", starterId: parsed.data.starterId }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * Resolve existing UI choices once. Known starter semantics and selected
 * resources are authoritative; free-text classification is fallback-only.
 */
export function resolveComposerTaskContext(input: ComposerTaskSelection & {
  fallbackPostCount: number | null;
  /**
   * A count the user explicitly stated in the message ("make it 5 posts").
   * Distinct from `fallbackPostCount`, which also carries the parser's
   * IMPLICIT single-post assumption (requestedBasePostCount returns 1 for any
   * post request whose count it cannot parse). Only the explicit count may
   * beat a starter-implied default — otherwise a 3-part series collapses to
   * one draft whenever the message has no parseable number.
   */
  explicitMessagePostCount?: number | null;
}): ComposerTaskContext {
  const starter = input.starterId ? STARTER_TASKS[input.starterId] : undefined;
  const selectedSourceId = input.selectedSourceId?.trim();
  const kind =
    input.commandKind === "create"
      ? "post"
      : input.commandKind === "ask"
        ? starter?.kind === "ideas"
          ? "ideas"
          : "answer"
        : input.commandKind === "edit"
          ? "answer"
        : starter?.kind ??
          (selectedSourceId || input.fallbackPostCount !== null
            ? "post"
            : "answer");
  const sourceMode = selectedSourceId
    ? "selected"
    : (starter?.sourceMode ?? "unspecified");
  const context = {
    sourceMode,
    ...(selectedSourceId ? { selectedSourceId } : {}),
    ...(input.starterId ? { starterId: input.starterId } : {}),
    ...(!selectedSourceId && starter?.sourceSelection
      ? { sourceSelection: starter.sourceSelection }
      : {}),
  };
  if (kind === "post") {
    // Priority: explicit UI pick > explicit message count > starter-implied
    // default > parser fallback (which may be an implicit 1) > 1. The starter
    // default only fires when the first two are silent, so a user edit like
    // "make it a 5-part series" still wins.
    const expectedDraftCount =
      input.selectedDraftCount ??
      input.explicitMessagePostCount ??
      starter?.defaultDraftCount ??
      input.fallbackPostCount ??
      1;
    const researchRequirement = materializeResearchRequirement(
      !selectedSourceId ? starter?.research : undefined,
      expectedDraftCount,
    );
    return {
      ...context,
      kind,
      expectedDraftCount,
      ...(researchRequirement ? { researchRequirement } : {}),
    };
  }
  const researchRequirement = materializeResearchRequirement(
    !selectedSourceId ? starter?.research : undefined,
    null,
  );
  return {
    ...context,
    kind,
    expectedDraftCount: null,
    ...(researchRequirement ? { researchRequirement } : {}),
  };
}
