import { PageShell } from "@/components/app-surface";

export default function VoiceLoading() {
  return (
    <PageShell className="animate-pulse">
      <div className="rounded-xl border border-border/60 bg-card/70 px-4 py-4 shadow-soft sm:px-5">
        <div className="h-8 w-28 rounded-md bg-muted" />
        <div className="mt-3 h-4 w-full max-w-lg rounded-md bg-muted/70" />
      </div>
      <div className="max-w-3xl space-y-4">
        <div className="rounded-xl border border-border/60 bg-card/80 p-5 shadow-soft">
          <div className="h-4 w-40 rounded bg-muted/70" />
          <div className="mt-4 h-9 w-full rounded-md bg-muted/60" />
          <div className="mt-3 h-9 w-44 rounded-md bg-muted/60" />
        </div>
        <div className="rounded-xl border border-border/60 bg-card/80 p-5 shadow-soft">
          <div className="h-4 w-44 rounded bg-muted/70" />
          <div className="mt-4 h-20 rounded-md bg-muted/60" />
        </div>
      </div>
    </PageShell>
  );
}
