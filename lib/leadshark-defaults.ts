import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  defaultLeadSharkAutomationDefaults,
  type LeadSharkAutomationDefaults,
} from "@/lib/leadshark-default-config";
import { MAX_KEYWORDS } from "@/lib/leadshark";

export const leadSharkAutomationDefaultsSchema = z.object({
  keywords: z.array(z.string().trim().min(1)).max(MAX_KEYWORDS).default([]),
  dmTemplate: z.string().trim().min(1).max(2_000),
  dmTemplateVariations: z.array(z.string().trim().min(1).max(2_000)).max(10),
  commentReplyTemplates: z.array(z.string().trim().min(1).max(2_000)).max(10),
  nonConnectionReplyTemplates: z
    .array(z.string().trim().min(1).max(2_000))
    .max(10),
  autoConnect: z.boolean(),
  autoLike: z.boolean(),
  followUpEnabled: z.boolean(),
  followUpTemplate: z.string().trim().max(2_000).nullable(),
  followUpDelayMinutes: z.number().int().positive().max(43_200),
  followUpOnlyIfNoResponse: z.boolean(),
});

export async function getLeadSharkAutomationDefaults(
  workspaceId: string,
  client: SupabaseClient,
): Promise<LeadSharkAutomationDefaults> {
  const { data, error } = await client
    .from("leadshark_automation_defaults")
    .select("config")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  const parsed = leadSharkAutomationDefaultsSchema.safeParse(data?.config);
  return parsed.success
    ? parsed.data
    : defaultLeadSharkAutomationDefaults();
}

export async function saveLeadSharkAutomationDefaults(
  workspaceId: string,
  config: LeadSharkAutomationDefaults,
  client: SupabaseClient,
): Promise<void> {
  const { error } = await client
    .from("leadshark_automation_defaults")
    .upsert(
      {
        workspace_id: workspaceId,
        config,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id" },
    );
  if (error) throw error;
}
