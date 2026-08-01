import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { enqueueKnowledgeIngestion } from "@/lib/knowledge-sources/operations";
import {
  matchesDeclaredKnowledgeSize,
  validateKnowledgeUpload,
} from "@/lib/knowledge-sources/ingestion";
import { failKnowledgeSourceUpload } from "@/app/api/knowledge-sources/_failure";

export const runtime = "nodejs";

const schema = z.object({
  sourceId: z.string().uuid(),
  path: z.string().min(1).max(900),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid upload." },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    if (
      !parsed.data.path.startsWith(
        `${sb.workspaceId}/${parsed.data.sourceId}/`,
      )
    ) {
      return NextResponse.json(
        { ok: false, error: "Upload path does not belong to this source." },
        { status: 400 },
      );
    }
    const { data: source, error } = await sb.raw
      .from("knowledge_sources")
      .select("id,title,mime_type,original_filename,status,request_key,ingestion_job_id,pending_storage_path,declared_size_bytes")
      .eq("workspace_id", sb.workspaceId)
      .eq("id", parsed.data.sourceId)
      .eq("kind", "file")
      .maybeSingle();
    if (error) throw error;
    if (!source) {
      return NextResponse.json(
        { ok: false, error: "This upload is no longer available." },
        { status: 409 },
      );
    }
    if (source.status === "ready" || source.status === "processing") {
      return NextResponse.json({
        ok: true,
        sourceId: source.id,
        jobId: source.ingestion_job_id,
        status: source.status,
      });
    }
    if (source.status !== "pending") {
      return NextResponse.json(
        { ok: false, error: "This upload is no longer available." },
        { status: 409 },
      );
    }
    if (source.request_key !== `file:${parsed.data.contentHash}`) {
      return NextResponse.json(
        { ok: false, error: "Uploaded file does not match this source." },
        { status: 409 },
      );
    }
    if (source.pending_storage_path !== parsed.data.path) {
      return NextResponse.json(
        { ok: false, error: "Uploaded file does not match this source." },
        { status: 409 },
      );
    }
    const { data: objects, error: listError } = await sb.raw.storage
      .from("knowledge-sources")
      .list(`${sb.workspaceId}/${source.id}`, {
        search: parsed.data.path.split("/").at(-1),
        limit: 2,
      });
    if (listError) throw listError;
    const object = objects?.find(
      (candidate) => parsed.data.path.endsWith(`/${candidate.name}`),
    );
    if (!object) {
      return NextResponse.json(
        { ok: false, error: "Upload did not finish. Try again." },
        { status: 409 },
      );
    }
    const sizeBytes = Number(object.metadata?.size ?? 0);
    const validation = validateKnowledgeUpload({
      filename: source.original_filename,
      mimeType: source.mime_type,
      sizeBytes,
    });
    const sizeMatchesReservation = matchesDeclaredKnowledgeSize(
      sizeBytes,
      source.declared_size_bytes,
    );
    if (!validation.ok || !sizeMatchesReservation) {
      await failKnowledgeSourceUpload({
        db: sb.raw,
        workspaceId: sb.workspaceId,
        sourceId: source.id,
        storagePath: parsed.data.path,
        errorCode: sizeMatchesReservation
          ? "invalid_uploaded_file"
          : "uploaded_size_mismatch",
      });
      return NextResponse.json(
        {
          ok: false,
          error: validation.ok
            ? "The uploaded file size changed. Choose the file again."
            : validation.error,
        },
        { status: 400 },
      );
    }
    const job = await enqueueKnowledgeIngestion({
      workspaceId: sb.workspaceId,
      sourceId: source.id,
      kind: "file",
      title: source.title,
      mimeType: source.mime_type,
      sizeBytes,
      originalFilename: source.original_filename,
      expectedHash: parsed.data.contentHash,
      storagePath: parsed.data.path,
      db: sb.raw,
    });
    return NextResponse.json(
      { ok: true, sourceId: source.id, jobId: job.id },
      { status: 202 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
