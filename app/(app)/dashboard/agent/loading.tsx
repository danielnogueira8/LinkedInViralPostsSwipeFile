import { PageHeader, PageShell } from "@/components/app-surface";
import { TimedLoadingState } from "@/components/ui/timed-loading-state";

export default function AgentLoading() {
  return (
    <PageShell width="full" aria-busy="true">
      <PageHeader
        title="Your Agent"
        description="Fresh, evidence-backed directions for what to write next."
      />
      <TimedLoadingState label="Loading your agent" />
      <div className="animate-pulse rounded-[1.75rem] border border-border bg-card/60 p-4 sm:p-6">
        <div className="h-12 w-72 rounded-xl bg-muted" />
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="h-[30rem] rounded-[1.75rem] bg-muted/70"
            />
          ))}
        </div>
      </div>
    </PageShell>
  );
}
