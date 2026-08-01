import type { SupabaseClient } from "@supabase/supabase-js";
import { createAgentInbox } from "@/lib/agent-inbox";
import { createAgentInboxEvidenceLoader } from "@/lib/agent-inbox/evidence";
import { createAgentInboxRepository } from "@/lib/agent-inbox/supabase";
import { createAgentInboxSynthesis } from "@/lib/agent-inbox/synthesis";

export function createProductionAgentInbox(db: SupabaseClient) {
  return createAgentInbox({
    repository: createAgentInboxRepository(db),
    loadEvidence: createAgentInboxEvidenceLoader(db),
    synthesis: createAgentInboxSynthesis(),
  });
}
