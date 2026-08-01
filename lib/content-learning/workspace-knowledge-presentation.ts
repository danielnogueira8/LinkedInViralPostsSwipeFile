import { wrapUntrustedXml } from "@/lib/agent/untrusted";
import type { WorkspaceKnowledgeItem } from "@/lib/content-learning/contracts";

function joinKnowledgeText(...parts: Array<string | null>): string {
  return parts
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
}

/**
 * Render the complete human-facing payload for a review card.
 *
 * Some knowledge kinds have a short label field plus a longer answer field
 * (for example, topic + basis). The label is useful as a title, but it is not
 * the answer. Keeping this mapping in one place prevents the review UI from
 * accidentally hiding the detail that was actually persisted.
 */
export function workspaceKnowledgeDisplayText(
  item: WorkspaceKnowledgeItem,
): string {
  const content = item.content;
  if ("summary" in content) {
    return joinKnowledgeText(content.summary, content.details);
  }
  if ("statement" in content) {
    return joinKnowledgeText(content.statement, content.rationale);
  }
  if ("claim" in content) {
    return joinKnowledgeText(
      content.claim,
      "evidence" in content ? content.evidence : content.reason,
    );
  }
  if ("name" in content) return content.promise ?? content.name;
  if ("insight" in content) return content.insight;
  return content.basis ?? content.topic;
}

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
