import { PageHeader, PageShell } from "@/components/app-surface";
import { AgentInbox } from "../agent-inbox";

export default function AgentPage() {
  return (
    <PageShell width="full">
      <PageHeader
        title="Content opportunities"
        description="Review evidence-backed directions and choose what deserves your point of view."
      />
      <AgentInbox />
    </PageShell>
  );
}
