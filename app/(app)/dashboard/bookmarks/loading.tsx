// Streams instantly on sidebar nav so the page feels responsive while the
// server queries run. Replaced by the real grid once data lands.
export default function BookmarksLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-9 w-44 rounded-md bg-muted" />
          <div className="h-4 w-72 rounded-md bg-muted/70" />
        </div>
        <div className="h-8 w-28 rounded-md bg-muted/70" />
      </div>
      <div className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        <div className="px-4 sm:px-5 py-3 bg-background/40 flex gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-7 w-20 rounded-full bg-muted/70" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
            <div className="px-4 py-2 border-b border-border/60 bg-muted/30 flex items-center justify-between">
              <div className="h-3 w-20 rounded bg-muted/70" />
              <div className="h-3 w-12 rounded bg-muted/70" />
            </div>
            <div className="h-[568px] bg-muted/30" />
          </div>
        ))}
      </div>
    </div>
  );
}
