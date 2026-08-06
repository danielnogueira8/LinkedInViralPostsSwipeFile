// Moved to lib/anti-slop-detectors.ts so SHIPPED code can use these checks —
// the check_draft MCP tool runs them, and until that move they were reachable
// only from the eval suite (a full, well-tested detector set that no runtime
// path could call).
//
// This re-export keeps the existing eval imports working rather than churning
// every call site in the same change.
export * from "@/lib/anti-slop-detectors";
