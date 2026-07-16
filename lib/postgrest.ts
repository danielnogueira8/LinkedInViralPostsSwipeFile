// Small, dependency-free helpers for building raw PostgREST expressions.
//
// Kept in its own leaf module (no imports, no side effects) so every call site
// can import the encoder without pulling in supabase-scoped's request-scoped
// machinery — and so test mocks of supabase-scoped don't have to re-stub it.

// PostgREST .or() values containing reserved characters (commas, parens, dots
// in some positions) must be wrapped in double quotes. We pass safe values
// through unquoted to keep query logs readable, and quote anything else.
// Used at every site that interpolates a value into an `.or()` predicate
// (lib/categories.ts, lib/supabase-scoped.ts) so they encode identically.
export function encodePostgrestValue(v: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(v)) return v;
  // Escape embedded backslashes and double quotes per PostgREST grammar.
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
