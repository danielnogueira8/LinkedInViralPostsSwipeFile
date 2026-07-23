import { PageHeader, PageShell } from "@/components/app-surface";

export default function AgentLoading() {
  return (
    <PageShell width="full" role="status" aria-live="polite">
      <PageHeader
        title="Your Agent"
        description="Set this week's direction, review drafts, and act on opportunities your agent found."
      />
      <div className="animate-pulse rounded-2xl border border-border bg-card/60 p-4 sm:p-5">
        <div className="h-14 rounded-xl bg-muted" />
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className="h-56 rounded-xl bg-muted/70" />
          ))}
        </div>
      </div>
    </PageShell>
  );
}
