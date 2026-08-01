import { describe, expect, test } from "vitest";
import {
  BACKGROUND_MODEL,
  CHAT_MODEL,
  EMBEDDING_MODEL,
  IMAGE_GENERATION_MODEL,
} from "@/lib/openrouter";
import {
  PRIMARY_ACTION_ORCHESTRATOR_MODEL,
  PRIMARY_WEB_RESEARCH_MODEL,
} from "@/lib/agent/execute/agent";
import {
  PRIMARY_DRAFT_WRITER_MODEL,
  PRIMARY_NEWS_MODEL,
  PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
  THIN_DRAFT_WRITER_MODEL,
} from "@/lib/agent/model-config";
import { PATTERN_MODEL } from "@/lib/batch/pattern-brief";
import { BACKSTORY_MODEL } from "@/lib/agent/specialists/backstory";
import { FRESHNESS_MODEL } from "@/lib/agent/specialists/freshness";
import { SAMENESS_MODEL } from "@/lib/agent/specialists/sameness";
import { SOURCE_FIDELITY_MODEL } from "@/lib/agent/specialists/source-fidelity";
import { resolveAiTellModel } from "@/lib/agent/specialists/ai-tell-repair";
import { VISION_MODEL } from "@/lib/agent/turn/context";
import {
  LEAD_MAGNET_IMAGE_ANALYSIS_MODEL,
  LEAD_MAGNET_IMAGE_FALLBACK_MODEL,
} from "@/lib/lead-magnet-image-generation";
import { routesToNativeOpenAI } from "@/lib/openai";
import {
  isOpenAIImageModel,
  OPENAI_IMAGE_MODEL,
  OPENAI_LUNA_MODEL,
  resolveNativeOpenAIPrimary,
} from "@/lib/model-provider-routing";

describe("default provider boundary", () => {
  test("routes every primary AI workload directly to OpenAI", () => {
    const primaryModels = [
      CHAT_MODEL,
      BACKGROUND_MODEL,
      EMBEDDING_MODEL,
      IMAGE_GENERATION_MODEL,
      PRIMARY_DRAFT_WRITER_MODEL,
      THIN_DRAFT_WRITER_MODEL,
      PRIMARY_NEWS_MODEL,
      PRIMARY_READ_ONLY_ORCHESTRATOR_MODEL,
      PRIMARY_ACTION_ORCHESTRATOR_MODEL,
      PRIMARY_WEB_RESEARCH_MODEL,
      LEAD_MAGNET_IMAGE_ANALYSIS_MODEL,
      VISION_MODEL,
      PATTERN_MODEL,
      BACKSTORY_MODEL,
      FRESHNESS_MODEL,
      SAMENESS_MODEL,
      SOURCE_FIDELITY_MODEL,
      resolveAiTellModel(),
    ];

    for (const model of primaryModels) {
      expect(model, `${model} must route natively to OpenAI`).toSatisfy(
        routesToNativeOpenAI,
      );
    }
  });

  test("keeps the lead-magnet image fallback provider-diverse", () => {
    expect(routesToNativeOpenAI(LEAD_MAGNET_IMAGE_FALLBACK_MODEL)).toBe(false);
  });

  test("rejects stale non-OpenAI primary overrides instead of rerouting them", () => {
    expect(
      resolveNativeOpenAIPrimary(["google/gemini-3.5-flash"], OPENAI_LUNA_MODEL),
    ).toBe(OPENAI_LUNA_MODEL);
    expect(
      resolveNativeOpenAIPrimary(
        ["google/gemini-3-pro-image"],
        OPENAI_IMAGE_MODEL,
        isOpenAIImageModel,
      ),
    ).toBe(OPENAI_IMAGE_MODEL);
  });
});
