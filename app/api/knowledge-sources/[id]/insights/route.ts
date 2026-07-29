import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import type { KnowledgeProposalDetail } from "@/lib/knowledge-sources/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const parsedId = idSchema.safeParse((await params).id);
    if (!parsedId.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid knowledge source." },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const { data: marker, error: markerError } = await sb.raw
      .from("app_schema_version")
      .select("version")
      .eq("singleton", true)
      .maybeSingle();
    if (markerError) throw markerError;
    if ((marker?.version ?? 0) < 149) {
      return NextResponse.json({ ok: true, available: false, items: [] });
    }

    const { data: source, error: sourceError } = await sb.raw
      .from("knowledge_sources")
      .select("id,current_revision_id,status")
      .eq("workspace_id", sb.workspaceId)
      .eq("id", parsedId.data)
      .neq("status", "archived")
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) {
      return NextResponse.json(
        { ok: false, error: "Knowledge source not found." },
        { status: 404 },
      );
    }
    if (!source.current_revision_id) {
      return NextResponse.json({ ok: true, available: true, items: [] });
    }

    const { data: evidenceRows, error: evidenceError } = await sb.raw
      .from("knowledge_item_evidence")
      .select("item_id,excerpt,start_offset,end_offset")
      .eq("workspace_id", sb.workspaceId)
      .eq("source_revision_id", source.current_revision_id)
      .limit(500);
    if (evidenceError) throw evidenceError;
    const itemIds = [
      ...new Set((evidenceRows ?? []).map((row) => row.item_id)),
    ];
    if (itemIds.length === 0) {
      return NextResponse.json({ ok: true, available: true, items: [] });
    }
    const { data: itemRows, error: itemsError } = await sb.raw
      .from("workspace_knowledge_items")
      .select(
        "id,kind,title,content,confidence,verification,active,updated_at",
      )
      .eq("workspace_id", sb.workspaceId)
      .in("id", itemIds)
      .in("verification", ["proposed", "verified"])
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(200);
    if (itemsError) throw itemsError;

    const evidenceByItem = new Map<
      string,
      KnowledgeProposalDetail["evidence"]
    >();
    for (const row of evidenceRows ?? []) {
      const current = evidenceByItem.get(row.item_id) ?? [];
      current.push({
        excerpt: row.excerpt,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
      });
      evidenceByItem.set(row.item_id, current);
    }
    const items = (itemRows ?? []).map(
      (row): KnowledgeProposalDetail => ({
        id: row.id,
        kind: row.kind as KnowledgeProposalDetail["kind"],
        title: row.title,
        content: row.content as Record<string, string | null>,
        confidence: row.confidence,
        verification:
          row.verification as KnowledgeProposalDetail["verification"],
        updatedAt: row.updated_at,
        evidence: evidenceByItem.get(row.id) ?? [],
      }),
    );
    return NextResponse.json({ ok: true, available: true, items });
  } catch (error) {
    return errorResponse(error);
  }
}
