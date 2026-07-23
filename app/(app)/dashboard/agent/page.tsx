import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader, PageShell } from "@/components/app-surface";
import { AgentBriefing } from "../agent-briefing";

export default function AgentPage() {
  return (
    <PageShell width="full">
      <PageHeader
        title="Your Agent"
        description="Set this week's direction, review drafts, and act on opportunities your agent found."
        actions={
          <Link
            href="/dashboard?new=1"
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Plus className="h-4 w-4" aria-hidden />
            New session
          </Link>
        }
      />
      <AgentBriefing />
    </PageShell>
  );
}
