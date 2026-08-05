import { LoadingState } from "@/components/ui/loading-state";

// Route-level loading boundary for the marketing segment.
//
// The visible "Loading SwipeIn" wordmark is gone: on a marketing page it read
// as a slow site, and the hero arrives moments later anyway. What remains is
// the pixel-chevron animation plus the accessible name — LoadingState renders
// `label` as an aria-label on the container AND as shimmering text, so
// `srOnlyLabel` keeps the announcement without painting the words.
//
// This file must exist and must keep a labelled LoadingState. Deleting it
// flips `/` from streamed (ƒ dynamic) to prerendered-at-build-time, which
// needs Supabase credentials and fails the build — verified. The label is
// also a tested accessibility contract for dynamic public routes
// (evals/data/public-surface-loading-and-metadata-regression.test.ts).
export default function MarketingLoading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center px-6">
      <LoadingState label="Loading SwipeIn" srOnlyLabel />
    </div>
  );
}
