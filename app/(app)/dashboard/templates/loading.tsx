import { LoadingState } from "@/components/ui/loading-state";

export default function TemplatesLoading() {
  return (
    <div className="space-y-6">
      <LoadingState label="Loading templates" />
      <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-9 w-40 rounded-md bg-muted" />
        <div className="h-4 w-96 max-w-full rounded-md bg-muted/70" />
      </div>
      <div className="flex items-center justify-between">
        <div className="h-4 w-56 rounded-md bg-muted/70" />
        <div className="h-9 w-36 rounded-md bg-muted/70" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border/60 bg-card shadow-soft p-4 space-y-3">
            <div className="h-4 w-1/3 rounded bg-muted" />
            <div className="h-3 w-full rounded bg-muted/70" />
            <div className="h-3 w-11/12 rounded bg-muted/70" />
            <div className="h-3 w-4/5 rounded bg-muted/70" />
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}
