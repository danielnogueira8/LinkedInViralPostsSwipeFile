import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { draftFromPrompt } from "@/lib/agent-loop/act";

export const runtime = "nodejs";
// A full turn: structure match + voice load + writer + board save.
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// POST /api/agent/week-plan/draft — "Draft this" on a generic plan day (Phase
// F v2). The prompt is the under-the-hood instruction behind the day ("talk
// about a recent client win"); the normal original-post pipeline writes it in
// the user's voice and the draft lands on the board like any agent draft.
// -----------------------------------------------------------------------------
const draftSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(8, "Prompt is too short.")
    .max(300, "Prompt is too long.")
    // Single line — the prompt is interpolated into the turn instruction.
    .refine((value) => !/[\r\n]/.test(value), "Prompt must be one line."),
});

export async function POST(req: Request) {
  try {
    const { prompt } = draftSchema.parse(await req.json());
    const sb = await scopedSupabase();
    const result = await draftFromPrompt(sb.raw, sb.workspaceId, prompt);
    if (!result.ok) {
      return errorResponse(new Error(result.reason));
    }
    return NextResponse.json({ ok: true, draftIds: result.draftIds });
  } catch (e) {
    return errorResponse(e);
  }
}
