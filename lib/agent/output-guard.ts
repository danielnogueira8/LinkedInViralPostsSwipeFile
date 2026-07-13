export type LeakRedactionReason =
  | "system_prompt"
  | "tool_schema"
  | "env_assignment"
  | "secret_token"
  | "workspace_identifier";

export type AgentGuardKind =
  | "deadline"
  | "forced_final"
  | "empty_result"
  | "cancel"
  | "output_redaction"
  | "invalid_artifact";

export function agentGuardLogLine(opts: {
  workspaceId: string;
  chatKind?: string;
  guard: AgentGuardKind;
  reason?: string;
  details?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    agent_guard: {
      workspace_id: opts.workspaceId,
      chat_kind: opts.chatKind ?? "chat",
      guard: opts.guard,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.details ? { details: opts.details } : {}),
    },
  });
}

const REDACTED_INTERNAL = "[internal details redacted]";
const REDACTED_SECRET = "[secret redacted]";
const REDACTED_WORKSPACE = "[workspace id redacted]";
const LEAK_PATTERNS: Array<{
  reason: LeakRedactionReason;
  pattern: RegExp;
  replacement: string;
}> = [
  {
    reason: "system_prompt",
    pattern: /You are the SwipeIn content assistant[\s\S]{0,1200}?(?=\n\n(?:Style:|Formatting of your replies|$))/gi,
    replacement: REDACTED_INTERNAL,
  },
  {
    reason: "system_prompt",
    pattern: /How to work:\s*\n- ACT, don't announce[\s\S]{0,1200}?(?=\n- [A-Z][A-Z ]{2,}|$)/gi,
    replacement: REDACTED_INTERNAL,
  },
  {
    reason: "tool_schema",
    pattern: /\{\s*"type"\s*:\s*"function"\s*,\s*"function"\s*:\s*\{[\s\S]{0,1600}?"parameters"\s*:\s*\{[\s\S]{0,1600}?\}\s*\}\s*\}/gi,
    replacement: REDACTED_INTERNAL,
  },
  {
    reason: "tool_schema",
    pattern: /"parameters"\s*:\s*\{\s*"type"\s*:\s*"object"[\s\S]{0,1200}?"properties"\s*:/gi,
    replacement: REDACTED_INTERNAL,
  },
  {
    reason: "env_assignment",
    pattern: /\b(?:OPENROUTER|APIFY|ZERNIO|SUPABASE|CLERK|ANTHROPIC|RESEND|CRON|DATABASE)_[A-Z0-9_]*\s*=\s*["']?[^\s"']{12,}/g,
    replacement: REDACTED_SECRET,
  },
  {
    reason: "secret_token",
    pattern: /\bsk-or-v1-[A-Za-z0-9_-]{24,}\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    reason: "secret_token",
    pattern: /\b(?:eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    reason: "workspace_identifier",
    pattern: /"workspace_id"\s*:\s*"org_[A-Za-z0-9_-]+"/g,
    replacement: `"workspace_id":"${REDACTED_WORKSPACE}"`,
  },
  {
    reason: "workspace_identifier",
    pattern: /\bworkspace_id\s*=\s*org_[A-Za-z0-9_-]+\b/g,
    replacement: `workspace_id=${REDACTED_WORKSPACE}`,
  },
];

export function redactHighConfidenceLeaks(text: string): {
  text: string;
  reasons: LeakRedactionReason[];
} {
  const reasons = new Set<LeakRedactionReason>();
  let output = text;
  for (const { reason, pattern, replacement } of LEAK_PATTERNS) {
    output = output.replace(pattern, (match) => {
      if (!match) return match;
      reasons.add(reason);
      return replacement;
    });
  }
  return { text: output, reasons: [...reasons] };
}
