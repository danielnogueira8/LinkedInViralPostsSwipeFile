/**
 * Canonical persisted transcript projection.
 *
 * Cowork has two server-side loading paths: the dashboard's first render and
 * the chat API used after navigation/reload. Keeping their projection here
 * prevents persisted message state from silently disappearing in one path.
 */
export const CHAT_MESSAGE_TRANSCRIPT_SELECT =
  "id, role, content, content_format, tool_calls, tool_call_id, artifacts, created_at, client_turn_id, transport_recovery_requested_at, user_stop_requested_at, terminal_reason, model_source_id, applied_skills, no_model_format_id, creator_style_context, lead_magnet_id, recoverable_error, turn_usage";
