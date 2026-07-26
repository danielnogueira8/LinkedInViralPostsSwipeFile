import { wrapUntrustedXml } from "@/lib/agent/untrusted";
import type { WorkspaceKnowledgeItem } from "@/lib/content-learning/contracts";

type ModelFacingKnowledge = Pick<
  WorkspaceKnowledgeItem,
  "kind" | "title" | "content"
>;

export function renderWorkspaceKnowledgeBlock(
  items: WorkspaceKnowledgeItem[],
): string {
  const verified = items
    .filter((item) => item.active && item.verification === "verified")
    .map(
      (item): ModelFacingKnowledge => ({
        kind: item.kind,
        title: item.title,
        content: item.content,
      }),
    );
  if (verified.length === 0) return "";

  return [
    "VERIFIED WORKSPACE KNOWLEDGE (user-approved facts and constraints):",
    "Use only when relevant. Do not turn these items into a checklist or invent missing details.",
    wrapUntrustedXml("workspace-knowledge", JSON.stringify(verified)),
  ].join("\n");
}
