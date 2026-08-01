import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  KNOWLEDGE_SOURCE_BUCKET,
  validateKnowledgeUpload,
} from "@/lib/knowledge-sources/ingestion";
import {
  createPendingKnowledgeSource,
  knowledgeUploadPath,
  prepareKnowledgeSourceUpload,
} from "@/lib/knowledge-sources/operations";

export const runtime = "nodejs";

const schema = z.object({
  title: z.string().trim().min(1).max(240),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid file." },
        { status: 400 },
      );
    }
    const validation = validateKnowledgeUpload(parsed.data);
    if (!validation.ok) {
      return NextResponse.json(
        { ok: false, error: validation.error },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const source = await createPendingKnowledgeSource({
      workspaceId: sb.workspaceId,
      kind: "file",
      title: parsed.data.title,
      originalFilename: parsed.data.filename,
      mimeType: validation.mimeType,
      requestKey: `file:${parsed.data.contentHash}`,
      sizeBytes: parsed.data.sizeBytes,
      db: sb.raw,
    });
    if (
      source.status === "ready" ||
      source.status === "processing" ||
      source.ingestion_job_id
    ) {
      return NextResponse.json({
        ok: true,
        sourceId: source.id,
        jobId: source.ingestion_job_id,
        status: source.status,
      });
    }
    const path = knowledgeUploadPath(
      sb.workspaceId,
      source.id,
      parsed.data.filename,
    );
    await prepareKnowledgeSourceUpload({
      workspaceId: sb.workspaceId,
      sourceId: source.id,
      storagePath: path,
      db: sb.raw,
    });
    const { data, error } = await sb.raw.storage
      .from(KNOWLEDGE_SOURCE_BUCKET)
      .createSignedUploadUrl(path);
    if (error) {
      const { error: removeError } = await sb.raw.storage
        .from(KNOWLEDGE_SOURCE_BUCKET)
        .remove([path]);
      if (removeError) throw removeError;
      const { error: failError } = await sb.raw.rpc(
        "fail_knowledge_source_ingestion",
        {
        p_workspace_id: sb.workspaceId,
        p_source_id: source.id,
        p_error_code: "upload_initialization_failed",
        p_job_id: null,
        },
      );
      if (failError) throw failError;
      throw error;
    }
    return NextResponse.json({
      ok: true,
      sourceId: source.id,
      path,
      token: data.token,
      signedUrl: data.signedUrl,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
