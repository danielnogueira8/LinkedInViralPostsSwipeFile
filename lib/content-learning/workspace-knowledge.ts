import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  knowledgeReviewInputSchema,
  workspaceKnowledgeItemSchema,
  workspaceKnowledgeProposalSchema,
  type WorkspaceKnowledge,
  type WorkspaceKnowledgeItem,
  type WorkspaceKnowledgeProposal,
} from "@/lib/content-learning/contracts";

type KnowledgeRow = {
  id: string;
  schema_version: number;
  workspace_id: string;
  kind: WorkspaceKnowledgeItem["kind"];
  title: string;
  content: unknown;
  source: WorkspaceKnowledgeItem["source"];
  source_ref: string | null;
  confidence: number;
  verification: WorkspaceKnowledgeItem["verification"];
  last_verified_at: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type WorkspaceKnowledgeFailure = {
  operation: "propose" | "review" | "archive" | "listActive";
  error: unknown;
};

export type WorkspaceKnowledgeStoreOptions = {
  onFailure?: (failure: WorkspaceKnowledgeFailure) => void;
};

function reportDefault(failure: WorkspaceKnowledgeFailure): void {
  console.warn("[workspace-knowledge] operation failed", {
    operation: failure.operation,
    error:
      failure.error instanceof Error
        ? failure.error.message
        : String(failure.error),
  });
}

export function workspaceKnowledgeFromRow(
  row: KnowledgeRow,
): WorkspaceKnowledgeItem | null {
  const parsed = workspaceKnowledgeItemSchema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    source: row.source,
    sourceRef: row.source_ref,
    confidence: row.confidence,
    verification: row.verification,
    lastVerifiedAt: row.last_verified_at,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

function proposalKey(proposal: WorkspaceKnowledgeProposal): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        proposal.schemaVersion,
        proposal.workspaceId,
        proposal.kind,
        proposal.title,
        proposal.content,
        proposal.source,
        proposal.sourceRef,
      ]),
    )
    .digest("hex");
}

function proposalToRow(proposal: WorkspaceKnowledgeProposal) {
  return {
    schema_version: proposal.schemaVersion,
    workspace_id: proposal.workspaceId,
    proposal_key: proposalKey(proposal),
    kind: proposal.kind,
    title: proposal.title,
    content: proposal.content,
    source: proposal.source,
    source_ref: proposal.sourceRef,
    confidence: proposal.confidence,
    verification: "proposed",
    last_verified_at: null,
    active: true,
  };
}

export function createWorkspaceKnowledgeStore(
  db: SupabaseClient,
  options: WorkspaceKnowledgeStoreOptions = {},
): WorkspaceKnowledge {
  const report = options.onFailure ?? reportDefault;

  async function findByProposal(
    workspaceId: string,
    key: string,
  ): Promise<WorkspaceKnowledgeItem | null> {
    const { data, error } = await db
      .from("workspace_knowledge_items")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("proposal_key", key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const item = workspaceKnowledgeFromRow(data as KnowledgeRow);
    if (!item) throw new Error("Stored Workspace Knowledge item is invalid");
    return item;
  }

  return {
    async propose(proposal) {
      const parsed = workspaceKnowledgeProposalSchema.safeParse(proposal);
      if (!parsed.success) {
        report({ operation: "propose", error: parsed.error });
        return null;
      }
      const key = proposalKey(parsed.data);
      try {
        const { error } = await db
          .from("workspace_knowledge_items")
          .upsert(proposalToRow(parsed.data), {
            onConflict: "workspace_id,proposal_key",
            ignoreDuplicates: true,
          });
        if (error) throw error;
        return await findByProposal(parsed.data.workspaceId, key);
      } catch (error) {
        report({ operation: "propose", error });
        return null;
      }
    },

    async review(workspaceId, input) {
      const parsed = knowledgeReviewInputSchema.safeParse(input);
      if (!parsed.success) {
        report({ operation: "review", error: parsed.error });
        return null;
      }
      try {
        const { data, error } = await db.rpc(
          "review_workspace_knowledge_item",
          {
            p_workspace_id: workspaceId,
            p_item_id: parsed.data.itemId,
            p_expected_updated_at: parsed.data.expectedUpdatedAt,
            p_decision: parsed.data.decision,
            p_replacement: parsed.data.replacement,
          },
        );
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        const item = row
          ? workspaceKnowledgeFromRow(row as KnowledgeRow)
          : null;
        if (!item) throw new Error("Reviewed Workspace Knowledge item is invalid");
        return item;
      } catch (error) {
        report({ operation: "review", error });
        return null;
      }
    },

    async archive(workspaceId, itemId) {
      try {
        const { data, error } = await db
          .from("workspace_knowledge_items")
          .update({ active: false, updated_at: new Date().toISOString() })
          .eq("workspace_id", workspaceId)
          .eq("id", itemId)
          .eq("verification", "verified")
          .select("*")
          .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        const item = workspaceKnowledgeFromRow(data as KnowledgeRow);
        if (!item) throw new Error("Archived Workspace Knowledge item is invalid");
        return item;
      } catch (error) {
        report({ operation: "archive", error });
        return null;
      }
    },

    async listActive(workspaceId) {
      try {
        const { data, error } = await db
          .from("workspace_knowledge_items")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("verification", "verified")
          .eq("active", true)
          .order("updated_at", { ascending: false });
        if (error) throw error;
        return (data ?? []).map((row) => {
          const item = workspaceKnowledgeFromRow(row as KnowledgeRow);
          if (!item) throw new Error("Stored Workspace Knowledge item is invalid");
          return item;
        });
      } catch (error) {
        report({ operation: "listActive", error });
        return [];
      }
    },
  };
}
