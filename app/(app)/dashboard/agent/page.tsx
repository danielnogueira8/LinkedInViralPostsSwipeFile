import { PageHeader, PageShell } from "@/components/app-surface";
import { AgentInbox } from "../agent-inbox";

export default function AgentPage() {
  return (
    <PageShell width="full">
      <PageHeader
        title="Your Agent"
        description="Fresh, evidence-backed directions for what to write next."
      />
      <AgentInbox />
    </PageShell>
  );
}
