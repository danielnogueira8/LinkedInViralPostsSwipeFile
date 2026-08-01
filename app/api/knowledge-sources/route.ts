import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  publicKnowledgeSource,
  type StoredKnowledgeSource,
} from "@/lib/knowledge-sources/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const archiveSchema = z.object({
  sourceId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
});

async function schemaVersion(
  db: Awaited<ReturnType<typeof scopedSupabase>>["raw"],
): Promise<number> {
  const { data, error } = await db
    .from("app_schema_version")
    .select("version")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw error;
  return typeof data?.version === "number" ? data.version : 0;
}

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const version = await schemaVersion(sb.raw);
    if (version < 148) {
      return NextResponse.json({ ok: true, available: false, sources: [] });
    }
    const selection =
      version >= 149
        ? "id,kind,title,original_filename,mime_type,status,error_code,declared_size_bytes,ingestion_job_id,extraction_error_code,extraction_job:background_jobs!knowledge_sources_extraction_job_id_fkey(status),created_at,updated_at"
        : "id,kind,title,original_filename,mime_type,status,error_code,declared_size_bytes,ingestion_job_id,created_at,updated_at";
    const { data, error } = await sb.raw
      .from("knowledge_sources")
      .select(selection)
      .eq("workspace_id", sb.workspaceId)
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    return NextResponse.json({
      ok: true,
      available: true,
      sources: ((data ?? []) as unknown as StoredKnowledgeSource[]).map(
        publicKnowledgeSource,
      ),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const parsed = archiveSchema.safeParse(
      await request.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Choose a valid source to archive." },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const version = await schemaVersion(sb.raw);
    const archiveSelection =
      version >= 149
        ? "id,status,ingestion_job_id,pending_storage_path,extraction_job_id"
        : "id,status,ingestion_job_id,pending_storage_path";
    const { data: source, error: readError } = await sb.raw
      .from("knowledge_sources")
      .select(archiveSelection)
      .eq("workspace_id", sb.workspaceId)
      .eq("id", parsed.data.sourceId)
      .maybeSingle();
    if (readError) throw readError;
    if (!source) {
      return NextResponse.json(
        { ok: false, error: "Source not found." },
        { status: 404 },
      );
    }
    const storedSource = source as unknown as {
      status: string;
      extraction_job_id?: string | null;
    };
    if (storedSource.status === "archived") {
      return NextResponse.json({ ok: true });
    }
    if (
      storedSource.status === "processing" ||
      storedSource.status === "pending"
    ) {
      return NextResponse.json(
        { ok: false, error: "Wait for this source to finish processing." },
        { status: 409 },
      );
    }
    const extractionJobId =
      typeof storedSource.extraction_job_id === "string"
        ? storedSource.extraction_job_id
        : null;
    if (extractionJobId) {
      const { data: extractionJob, error: jobError } = await sb.raw
        .from("background_jobs")
        .select("status")
        .eq("workspace_id", sb.workspaceId)
        .eq("id", extractionJobId)
        .maybeSingle();
      if (jobError) throw jobError;
      if (
        extractionJob?.status === "queued" ||
        extractionJob?.status === "running"
      ) {
        return NextResponse.json(
          { ok: false, error: "Wait for this source to finish analyzing." },
          { status: 409 },
        );
      }
    }
    const { data, error } = await sb.raw.rpc("archive_knowledge_source", {
      p_workspace_id: sb.workspaceId,
      p_source_id: parsed.data.sourceId,
      p_expected_updated_at: parsed.data.expectedUpdatedAt,
    });
    if (error) {
      if ((error as { code?: string }).code === "40001") {
        return NextResponse.json(
          { ok: false, error: "This source changed. Refresh and try again." },
          { status: 409 },
        );
      }
      throw error;
    }
    if (!data) {
      return NextResponse.json(
        { ok: false, error: "This source changed. Refresh and try again." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
