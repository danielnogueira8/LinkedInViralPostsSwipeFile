import type { PostgrestError } from "@supabase/supabase-js";

// Surface PostgREST/Supabase read errors in server-component render paths.
//
// PostgREST returns { data: null, error } on a transient failure (statement
// timeout, connection-pool exhaustion, a network blip) rather than throwing.
// Server pages that destructured `const { data }` and dropped `error` then
// coalesced the null to `[]`/`null` (`data ?? []`), which made whole UI
// sections silently vanish or render misleadingly-empty — indistinguishable
// from "this workspace genuinely has no data".
//
// Call this with the results of the parallel reads that back a page's chrome.
// If ANY carries an error, throw — the nearest error boundary (e.g.
// app/(app)/dashboard/error.tsx) then shows a recoverable "Try again" instead
// of a degraded page. `label` is woven into the thrown message for triage.
//
// Only use this for reads whose failure should fail the page. Reads with an
// intentional graceful fallback (defaults, optional badges) should keep
// handling their own error and NOT be passed here.
export function assertNoQueryError(
  label: string,
  ...results: Array<{ error: PostgrestError | null }>
): void {
  for (const r of results) {
    if (r.error) {
      throw new Error(`Failed to load ${label}: ${r.error.message}`);
    }
  }
}
