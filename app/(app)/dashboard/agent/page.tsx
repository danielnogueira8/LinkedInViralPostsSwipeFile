import { PageHeader, PageShell } from "@/components/app-surface";
import { AgentInbox } from "../agent-inbox";

export default function AgentPage() {
  return (
    <PageShell width="full">
      <PageHeader
        title="Agent Inbox"
        description="Review today’s recommendations. New ideas arrive every day."
      />
      <AgentInbox />
    </PageShell>
  );
}
