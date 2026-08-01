import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  createPendingKnowledgeSource,
  enqueueKnowledgeIngestion,
} from "@/lib/knowledge-sources/operations";
import { sha256 } from "@/lib/knowledge-sources/ingestion";

export const runtime = "nodejs";

const schema = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(1_500_000),
});

export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid note." },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const requestKey = `note:${sha256(parsed.data.content)}`;
    const sizeBytes = Buffer.byteLength(parsed.data.content, "utf8");
    const source = await createPendingKnowledgeSource({
      workspaceId: sb.workspaceId,
      kind: "note",
      title: parsed.data.title,
      mimeType: "text/plain",
      requestKey,
      sizeBytes,
      db: sb.raw,
    });
    if (source.status === "ready") {
      return NextResponse.json({
        ok: true,
        sourceId: source.id,
        jobId: source.ingestion_job_id,
        status: "ready",
      });
    }
    const job = await enqueueKnowledgeIngestion({
      workspaceId: sb.workspaceId,
      sourceId: source.id,
      kind: "note",
      title: source.title,
      mimeType: "text/plain",
      sizeBytes,
      rawText: parsed.data.content,
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
