import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { verifyKey } from "@/lib/leadshark";
import {
  getCredentialSafe,
  storeVerifiedCredential,
  deleteCredential,
} from "@/lib/leadshark-credentials";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// The workspace's LeadShark connection (a USER-supplied API key).
//   GET    → safe status for the Integrations card { connected, keyHint, ... }.
//   POST   → validate the key against the LIVE LeadShark API, then encrypt+store.
//   DELETE → disconnect (hard-delete the encrypted credential).
//
// The key is write-only: it is never returned by any route, never logged, and
// only ever leaves the DB decrypted at point of use inside a server module.
// -----------------------------------------------------------------------------

export async function GET() {
  try {
    const workspaceId = await requireWorkspaceId();
    const credential = await getCredentialSafe(workspaceId);
    return NextResponse.json({ ok: true, credential });
  } catch (e) {
    return errorResponse(e);
  }
}

// A LeadShark key is a non-empty opaque string. We don't over-constrain the
// shape (LeadShark could change its key format) — the real validation is the
// live API call below.
const connectSchema = z.object({
  apiKey: z.string().trim().min(1, "Enter your LeadShark API key.").max(500),
});

export async function POST(req: Request) {
  try {
    const workspaceId = await requireWorkspaceId();

    const parsed = connectSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Invalid request.";
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }
    const { apiKey } = parsed.data;

    // Never store an unvalidated key. A cheap authenticated read proves the key
    // works AND that the plan includes API access before we persist anything.
    const check = await verifyKey(apiKey);
    if (!check.ok) {
      // Map the LeadShark error kind to a specific, actionable message + status.
      // We store NOTHING on any failure.
      const { kind, message } = check.error;
      const status =
        kind === "unauthorized" || kind === "forbidden"
          ? 400 // client-actionable: wrong/insufficient key
          : kind === "rate_limited"
            ? 429
            : 502; // transient/other: upstream problem
      return NextResponse.json({ ok: false, error: message, kind }, { status });
    }

    const credential = await storeVerifiedCredential(workspaceId, apiKey);
    return NextResponse.json({ ok: true, credential });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE() {
  try {
    const workspaceId = await requireWorkspaceId();
    await deleteCredential(workspaceId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
