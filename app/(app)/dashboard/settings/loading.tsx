import { PageShell } from "@/components/app-surface";

export default function SettingsLoading() {
  return (
    <PageShell className="animate-pulse">
      <div className="rounded-[1.15rem] border border-border/60 bg-card/72 px-4 py-4 shadow-soft sm:px-5">
        <div className="h-8 w-40 rounded-md bg-muted" />
        <div className="mt-3 h-4 w-full max-w-xl rounded-md bg-muted/70" />
      </div>
      <div className="max-w-3xl space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-[1.15rem] border border-border/60 bg-card/80 p-5 shadow-soft">
            <div className="h-4 w-40 rounded bg-muted/70" />
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div className="h-9 rounded-md bg-muted/60" />
              <div className="h-9 rounded-md bg-muted/60" />
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
