import { PageHeader, PageShell } from "@/components/app-surface";
import { AgentBriefing } from "../agent-briefing";

export default function AgentPage() {
  return (
    <PageShell width="full">
      <PageHeader
        title="Your Agent"
        description="Set this week's direction, review drafts, and act on opportunities your agent found."
      />
      <AgentBriefing />
    </PageShell>
  );
}
