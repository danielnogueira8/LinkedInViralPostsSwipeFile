import { PageShell } from "@/components/app-surface";

export default function AccountsLoading() {
  return (
    <PageShell width="wide" className="animate-pulse">
      <div className="rounded-[1.15rem] border border-border/60 bg-card/72 px-4 py-4 shadow-soft sm:px-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="h-6 w-24 rounded-full bg-muted/70" />
              <div className="h-6 w-24 rounded-full bg-muted/60" />
            </div>
            <div className="h-8 w-40 rounded-md bg-muted" />
            <div className="h-4 w-80 rounded-md bg-muted/70" />
          </div>
          <div className="h-9 w-32 rounded-md bg-muted/70" />
        </div>
      </div>
      <div className="grid gap-3 rounded-[1.15rem] border border-border/60 bg-background/50 p-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-[0.9rem] border border-border/50 bg-card/80 px-3 py-2.5">
            <div className="h-3 w-12 rounded bg-muted/60" />
            <div className="mt-2 h-4 w-24 rounded bg-muted/70" />
            <div className="mt-2 h-3 w-full rounded bg-muted/50" />
          </div>
        ))}
      </div>
      <div className="rounded-[1.15rem] border border-border/60 bg-card/88 shadow-soft overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr]">
          <div className="hidden md:block border-r border-border/60 bg-background/35 p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-7 rounded-md bg-muted/60" />
            ))}
          </div>
          <div className="p-4">
            <div className="h-8 w-full rounded-md bg-muted/60 mb-4" />
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="flex flex-col items-center gap-2 rounded-[1rem] border border-border/60 bg-card/80 p-4"
                >
                  <div className="h-12 w-12 rounded-full bg-muted/70" />
                  <div className="h-3.5 w-24 rounded bg-muted/60" />
                  <div className="h-2.5 w-16 rounded bg-muted/50" />
                  <div className="h-7 w-full rounded-md bg-muted/50 mt-1" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
