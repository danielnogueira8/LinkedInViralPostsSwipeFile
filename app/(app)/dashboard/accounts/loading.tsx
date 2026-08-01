import { PageShell } from "@/components/app-surface";
import { LoadingState } from "@/components/ui/loading-state";
import { CREATOR_CARD_GRID_CLASS } from "@/lib/discovery-display-policy";

function CreatorCardSkeleton() {
  return (
    <article className="flex min-h-[292px] min-w-0 flex-col gap-4 rounded-2xl border border-border/60 bg-card px-4 py-5 shadow-soft sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="h-14 w-14 shrink-0 rounded-full bg-muted" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-5 w-36 max-w-full rounded-md bg-muted" />
          <div className="h-4 w-24 rounded-md bg-muted/70" />
          <div className="space-y-1.5 pt-1">
            <div className="h-3.5 w-full rounded bg-muted/70" />
            <div className="h-3.5 w-3/4 rounded bg-muted/60" />
          </div>
        </div>
        <div className="h-10 w-10 shrink-0 rounded-lg bg-muted/60" />
      </div>

      <div className="rounded-xl bg-muted/55 px-3 py-3">
        <div className="space-y-2">
          <div className="h-3.5 w-full rounded bg-muted" />
          <div className="h-3.5 w-5/6 rounded bg-muted" />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="h-6 w-24 rounded-full bg-muted/70" />
        <div className="h-3 w-20 rounded bg-muted/60" />
        <div className="h-3 w-16 rounded bg-muted/50" />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/50 pt-3">
        <div className="h-3 w-44 max-w-[55%] rounded bg-muted/60" />
        <div className="h-10 w-28 rounded-lg bg-muted/70" />
      </div>
    </article>
  );
}

export default function AccountsLoading() {
  return (
    <PageShell
      width="wide"
      aria-busy="true"
    >
      <LoadingState label="Loading creators" />
      <div className="flex flex-col gap-5 animate-pulse sm:gap-6">
      <div className="rounded-xl border border-border/60 bg-card/70 px-4 py-4 shadow-soft sm:px-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="h-6 w-32 rounded-full bg-muted/70" />
              <div className="h-6 w-28 rounded-full bg-muted/60" />
            </div>
            <div className="h-9 w-36 rounded-md bg-muted" />
            <div className="h-4 w-[34rem] max-w-full rounded-md bg-muted/70" />
          </div>
          <div className="h-10 w-36 rounded-lg bg-muted/70" />
        </div>
      </div>

      <div className="space-y-6" aria-hidden="true">
        <div className="flex flex-col gap-4 border-b border-border/60 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex h-12 w-full max-w-[22rem] items-center gap-1 rounded-xl bg-muted p-1 sm:w-auto">
            <div className="h-10 w-40 rounded-lg bg-background" />
            <div className="h-10 w-40 rounded-lg bg-muted/70" />
          </div>
          <div className="h-4 w-80 max-w-full rounded bg-muted/60" />
        </div>

        <section className="space-y-3">
          <div className="space-y-2">
            <div className="h-5 w-64 max-w-full rounded bg-muted/80" />
            <div className="h-4 w-80 max-w-full rounded bg-muted/60" />
          </div>
          <div className="flex gap-2 overflow-hidden">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="h-11 w-32 shrink-0 rounded-full border border-border/60 bg-muted/60"
              />
            ))}
          </div>
        </section>

        <div className="flex flex-col gap-3 border-y border-border/60 py-3 sm:flex-row sm:items-center">
          <div className="h-11 min-w-0 flex-1 rounded-xl border border-border/60 bg-muted/60" />
          <div className="h-11 w-full rounded-xl border border-border/60 bg-muted/60 sm:w-40" />
        </div>

        <div className="space-y-2">
          <div className="h-6 w-48 rounded bg-muted/80" />
          <div className="h-4 w-40 rounded bg-muted/60" />
        </div>

        <div className={CREATOR_CARD_GRID_CLASS} data-testid="creator-card-grid">
          {Array.from({ length: 6 }).map((_, index) => (
            <CreatorCardSkeleton key={index} />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading creators</span>
      </div>
    </PageShell>
  );
}
