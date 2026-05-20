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
        <div className="px-4 py-3 border-b border-border/60 flex gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-4 flex-1 rounded bg-muted/70" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b border-border/60 flex gap-4 items-center">
            <div className="h-4 flex-1 rounded bg-muted/60" />
            <div className="h-4 flex-1 rounded bg-muted/60" />
            <div className="h-4 flex-1 rounded bg-muted/60" />
            <div className="h-4 flex-1 rounded bg-muted/60" />
            <div className="h-4 flex-1 rounded bg-muted/60" />
            <div className="h-4 w-6 rounded bg-muted/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
