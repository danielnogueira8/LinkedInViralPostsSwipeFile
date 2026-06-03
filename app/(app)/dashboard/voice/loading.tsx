export default function VoiceLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-9 w-32 rounded-md bg-muted" />
        <div className="h-4 w-96 rounded-md bg-muted/70" />
      </div>
      <div className="rounded-xl border border-border/60 bg-card shadow-soft p-6 space-y-4 max-w-2xl">
        <div className="h-4 w-40 rounded bg-muted/70" />
        <div className="h-9 w-full rounded-md bg-muted/60" />
        <div className="h-9 w-44 rounded-md bg-muted/60" />
      </div>
    </div>
  );
}
