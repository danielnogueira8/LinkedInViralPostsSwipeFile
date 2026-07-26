import type { SupabaseClient } from "@supabase/supabase-js";
import { createWorkspaceLearningStore } from "@/lib/content-learning/workspace-learning";
import { renderWorkspaceLearningBlock } from "@/lib/content-learning/workspace-learning-presentation";
import type { WorkspaceLearningModel } from "@/lib/content-learning/contracts";

export async function loadActiveWorkspaceLearning(
  db: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceLearningModel | null> {
  const model = await createWorkspaceLearningStore(db).refresh(
    workspaceId,
    { mode: "active" },
  );
  return model?.status === "active" ? model : null;
}

export async function loadWorkspaceLearningBlock(
  db: SupabaseClient,
  workspaceId: string,
): Promise<string> {
  const model = await loadActiveWorkspaceLearning(db, workspaceId);
  return model ? renderWorkspaceLearningBlock(model) : "";
}
