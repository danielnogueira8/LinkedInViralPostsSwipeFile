import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";

export type ImageAnalysisCacheKey = {
  dataUrl: string;
  prompt: string;
  model: string;
  promptVersion: number;
};

export function imageAnalysisInputHash(key: ImageAnalysisCacheKey): string {
  const hash = createHash("sha256");
  hash.update(String(key.promptVersion));
  hash.update("\0");
  hash.update(key.model);
  hash.update("\0");
  hash.update(key.prompt);
  hash.update("\0");
  hash.update(key.dataUrl);
  return hash.digest("hex");
}

export async function readImageAnalysisCache(opts: {
  workspaceId: string;
  analysisKind: string;
  inputHash: string;
  model: string;
  promptVersion: number;
}): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("image_analysis_cache")
      .select("result_text")
      .eq("workspace_id", opts.workspaceId)
      .eq("analysis_kind", opts.analysisKind)
      .eq("input_hash", opts.inputHash)
      .eq("model", opts.model)
      .eq("prompt_version", opts.promptVersion)
      .maybeSingle();
    if (error) return null;
    const text = typeof data?.result_text === "string" ? data.result_text.trim() : "";
    return text || null;
  } catch {
    return null;
  }
}

export async function writeImageAnalysisCache(opts: {
  workspaceId: string;
  analysisKind: string;
  inputHash: string;
  model: string;
  promptVersion: number;
  resultText: string;
}): Promise<void> {
  const resultText = opts.resultText.trim();
  if (!resultText) return;
  try {
    await supabaseAdmin().from("image_analysis_cache").upsert(
      {
        workspace_id: opts.workspaceId,
        analysis_kind: opts.analysisKind,
        input_hash: opts.inputHash,
        model: opts.model,
        prompt_version: opts.promptVersion,
        result_text: resultText,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,analysis_kind,input_hash" },
    );
  } catch {
    // Cache writes must never fail the user-facing AI operation.
  }
}

