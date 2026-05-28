export default function AccountsLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-9 w-40 rounded-md bg-muted" />
          <div className="h-4 w-72 rounded-md bg-muted/70" />
        </div>
        <div className="h-9 w-32 rounded-md bg-muted/70" />
      </div>
      <div className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr]">
          <div className="hidden md:block border-r border-border/60 bg-muted/30 p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-7 rounded-md bg-muted/60" />
            ))}
          </div>
          <div className="p-4">
            <div className="h-8 w-full rounded-md bg-muted/60 mb-4" />
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="flex flex-col items-center gap-2 rounded-xl border border-border/60 p-4"
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
    </div>
  );
}
