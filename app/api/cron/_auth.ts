import { NextResponse } from "next/server";

/**
 * Shared fail-closed authorization for cron adapters that have no user session.
 * The internal jobs-health adapter intentionally has a different interface and
 * keeps its admin-or-secret policy local.
 */
export function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
}

export function cronAuthorizationResponse(): Response {
  return NextResponse.json(
    { ok: false, error: "unauthorized" },
    { status: 401 },
  );
}
