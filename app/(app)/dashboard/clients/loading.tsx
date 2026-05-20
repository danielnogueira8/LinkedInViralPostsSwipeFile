export default function ClientsLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-9 w-32 rounded-md bg-muted" />
        <div className="h-4 w-80 rounded-md bg-muted/70" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border/60 bg-card shadow-soft p-4 space-y-3">
            <div className="h-5 w-2/5 rounded bg-muted" />
            <div className="flex gap-2">
              <div className="h-6 w-6 rounded bg-muted/70" />
              <div className="h-6 w-6 rounded bg-muted/70" />
              <div className="h-6 w-6 rounded bg-muted/70" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
