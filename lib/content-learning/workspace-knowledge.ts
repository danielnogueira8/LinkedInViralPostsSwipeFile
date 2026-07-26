import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  knowledgeReviewInputSchema,
  workspaceKnowledgeItemSchema,
  workspaceKnowledgeProposalSchema,
  type WorkspaceKnowledge,
  type WorkspaceKnowledgeItem,
  type WorkspaceKnowledgeProposal,
  type KnowledgeItemSource,
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
  operation:
    | "propose"
    | "replaceInterviewProposals"
    | "review"
    | "archive"
    | "listProposed"
    | "listActiveBySource"
    | "listActive";
  error: unknown;
};

export type WorkspaceKnowledgeStoreOptions = {
  onFailure?: (failure: WorkspaceKnowledgeFailure) => void;
};

export const WORKSPACE_KNOWLEDGE_SCAN_LIMIT = 50;
export const WORKSPACE_KNOWLEDGE_CONTEXT_ITEM_LIMIT = 20;
export const WORKSPACE_KNOWLEDGE_CONTEXT_CHAR_LIMIT = 40_000;

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

  async function parseRows(
    operation: WorkspaceKnowledgeFailure["operation"],
    rows: unknown[],
    itemLimit: number,
    charLimit: number,
  ): Promise<WorkspaceKnowledgeItem[]> {
    const items: WorkspaceKnowledgeItem[] = [];
    let usedChars = 0;
    for (const row of rows) {
      const item = workspaceKnowledgeFromRow(row as KnowledgeRow);
      if (!item) {
        report({
          operation,
          error: new Error("Stored Workspace Knowledge item is invalid"),
        });
        continue;
      }
      const itemChars =
        item.title.length + JSON.stringify(item.content).length;
      if (items.length >= itemLimit || usedChars + itemChars > charLimit) {
        break;
      }
      items.push(item);
      usedChars += itemChars;
    }
    return items;
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

    async replaceInterviewProposals(
      workspaceId,
      sourceRefPrefix,
      proposals,
    ) {
      const parsed = proposals.map((proposal) =>
        workspaceKnowledgeProposalSchema.safeParse(proposal),
      );
      const invalid = parsed.find((result) => !result.success);
      if (invalid && !invalid.success) {
        report({
          operation: "replaceInterviewProposals",
          error: invalid.error,
        });
        return null;
      }
      const validated = parsed.map((result) => {
        if (!result.success) {
          throw new Error("Workspace Knowledge proposal validation drift");
        }
        return result.data;
      });
      if (
        validated.some(
          (proposal) =>
            proposal.workspaceId !== workspaceId ||
            proposal.source !== "interview" ||
            !proposal.sourceRef?.startsWith(sourceRefPrefix),
        )
      ) {
        report({
          operation: "replaceInterviewProposals",
          error: new Error("Interview proposal scope does not match"),
        });
        return null;
      }

      try {
        const rows = validated.map((proposal) => ({
          schema_version: proposal.schemaVersion,
          proposal_key: proposalKey(proposal),
          kind: proposal.kind,
          title: proposal.title,
          content: proposal.content,
          identity_ref: `${sourceRefPrefix}${
            proposal.sourceRef
              ?.slice(sourceRefPrefix.length)
              .split(":", 1)[0] ?? ""
          }`,
          source_ref: proposal.sourceRef,
          confidence: proposal.confidence,
        }));
        const { data, error } = await db.rpc(
          "replace_interview_workspace_knowledge",
          {
            p_workspace_id: workspaceId,
            p_source_ref_prefix: sourceRefPrefix,
            p_proposals: rows,
          },
        );
        if (error) throw error;
        const returnedRows = Array.isArray(data) ? data : data ? [data] : [];
        const items = await parseRows(
          "replaceInterviewProposals",
          returnedRows,
          WORKSPACE_KNOWLEDGE_SCAN_LIMIT,
          WORKSPACE_KNOWLEDGE_CONTEXT_CHAR_LIMIT * 2,
        );
        if (items.length !== validated.length) {
          throw new Error(
            "Interview knowledge reconciliation returned an incomplete revision",
          );
        }
        return items;
      } catch (error) {
        report({ operation: "replaceInterviewProposals", error });
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

    async archive(workspaceId, itemId, expectedUpdatedAt) {
      try {
        const { data, error } = await db.rpc(
          "archive_workspace_knowledge_item",
          {
            p_workspace_id: workspaceId,
            p_item_id: itemId,
            p_expected_updated_at: expectedUpdatedAt,
          },
        );
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        const item = row
          ? workspaceKnowledgeFromRow(row as KnowledgeRow)
          : null;
        if (!item) throw new Error("Archived Workspace Knowledge item is invalid");
        return item;
      } catch (error) {
        report({ operation: "archive", error });
        return null;
      }
    },

    async listProposed(workspaceId) {
      try {
        const { data, error } = await db
          .from("workspace_knowledge_items")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("verification", "proposed")
          .eq("active", true)
          .order("created_at", { ascending: false })
          .limit(WORKSPACE_KNOWLEDGE_SCAN_LIMIT);
        if (error) throw error;
        return parseRows(
          "listProposed",
          data ?? [],
          WORKSPACE_KNOWLEDGE_CONTEXT_ITEM_LIMIT,
          WORKSPACE_KNOWLEDGE_CONTEXT_CHAR_LIMIT,
        );
      } catch (error) {
        report({ operation: "listProposed", error });
        return [];
      }
    },

    async listActiveBySource(
      workspaceId: string,
      source: KnowledgeItemSource,
      sourceRefPrefix: string,
    ) {
      try {
        const { data, error } = await db
          .from("workspace_knowledge_items")
          .select("*")
          .eq("workspace_id", workspaceId)
          .eq("source", source)
          .eq("active", true)
          .like("source_ref", `${sourceRefPrefix}%`)
          .order("updated_at", { ascending: false })
          .limit(WORKSPACE_KNOWLEDGE_SCAN_LIMIT);
        if (error) throw error;
        return parseRows(
          "listActiveBySource",
          data ?? [],
          WORKSPACE_KNOWLEDGE_SCAN_LIMIT,
          WORKSPACE_KNOWLEDGE_CONTEXT_CHAR_LIMIT * 2,
        );
      } catch (error) {
        report({ operation: "listActiveBySource", error });
        return [];
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
          .order("updated_at", { ascending: false })
          .limit(WORKSPACE_KNOWLEDGE_SCAN_LIMIT);
        if (error) throw error;
        return parseRows(
          "listActive",
          data ?? [],
          WORKSPACE_KNOWLEDGE_CONTEXT_ITEM_LIMIT,
          WORKSPACE_KNOWLEDGE_CONTEXT_CHAR_LIMIT,
        );
      } catch (error) {
        report({ operation: "listActive", error });
        return [];
      }
    },
  };
}
