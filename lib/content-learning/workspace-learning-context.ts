import type { SupabaseClient } from "@supabase/supabase-js";
import { createWorkspaceLearningStore } from "@/lib/content-learning/workspace-learning";
import { renderWorkspaceLearningBlock } from "@/lib/content-learning/workspace-learning-presentation";

export async function loadWorkspaceLearningBlock(
  db: SupabaseClient,
  workspaceId: string,
): Promise<string> {
  const model = await createWorkspaceLearningStore(db).refresh(
    workspaceId,
    { mode: "active" },
  );
  return model?.status === "active"
    ? renderWorkspaceLearningBlock(model)
    : "";
}
