import { createClient, SupabaseClient } from "@supabase/supabase-js";

let serverClient: SupabaseClient | null = null;

type AccessTokenProvider = () => Promise<string | null>;

const REQUEST_SERVICE_ROLE_RPCS = new Set([
  "cancel_active_chat_action_turn",
  "cancel_chat_action_turn",
  "checkpoint_modeled_draft_slot",
  "claim_ai_operation",
  "claim_chat_action_checkpoint",
  "claim_chat_turn",
  "claim_content_template_slot",
  "claim_media_quota",
  "claim_modeled_draft_batch",
  "claim_modeling_source_rotation_cursor",
  "claim_workspace_cost",
  "complete_modeled_draft_batch",
  "delete_chat_message_artifact",
  "execute_chat_action_checkpoint",
  "finish_chat_action_checkpoint",
  "hold_workspace_cost_claims",
  "persist_chat_assistant_turn",
  "release_ai_operation",
  "release_chat_action_turn_leases",
  "release_chat_turn_workspace_cost",
  "release_modeled_draft_batch",
  "release_workspace_cost",
  "reset_uncommitted_chat_action_turn",
  "save_chat_action_retry_context",
  "save_chat_draft",
  "save_standalone_draft",
]);

export function supabaseAdmin(): SupabaseClient {
  if (serverClient) return serverClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase URL or service role key missing");
  serverClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serverClient;
}

/**
 * Request-scoped Supabase client authenticated as the current Clerk user.
 *
 * Unlike supabaseAdmin(), this client does not bypass RLS. Authenticated pages
 * and route handlers use it so the database evaluates the caller's `sub` claim
 * in addition to the app's explicit workspace predicates. Cron and background
 * workers have no Clerk session and continue to use supabaseAdmin().
 */
export function supabaseForRequest(
  getAccessToken: AccessTokenProvider,
): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase URL or anon key missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    accessToken: getAccessToken,
  });
}

/**
 * Database capability exposed to authenticated server requests.
 *
 * Ordinary tables, RPCs, and storage buckets use the caller's Clerk JWT and
 * remain subject to RLS. A small allowlist preserves access to server-only
 * atomic functions whose migrations revoke `authenticated`; privileged RPCs
 * must carry the current workspace id. Service-only table and storage access
 * stays behind operation-specific repositories rather than this client.
 */
export function supabaseForWorkspaceRequest(
  getAccessToken: AccessTokenProvider,
  workspaceId: string,
  serviceClient: SupabaseClient = supabaseAdmin(),
): SupabaseClient {
  const requestClient = supabaseForRequest(getAccessToken);
  return new Proxy(requestClient, {
    get(target, property, receiver) {
      if (property === "rpc") {
        return (
          fn: string,
          args?: Record<string, unknown>,
          options?: {
            head?: boolean;
            get?: boolean;
            count?: "exact" | "planned" | "estimated";
          },
        ) => {
          if (!REQUEST_SERVICE_ROLE_RPCS.has(fn)) {
            return requestClient.rpc(fn, args, options);
          }
          const rpcWorkspaceId = args?.p_workspace_id;
          if (rpcWorkspaceId !== workspaceId) {
            throw new Error("Privileged RPC workspace mismatch");
          }
          return serviceClient.rpc(fn, args, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function supabaseBrowser(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(url, key);
}

export type Account = {
  id: string;
  name: string;
  profile_url: string;
  linkedin_handle: string;
  niche: string | null;
  synced_at: string;
};

export type Post = {
  id: string;
  account_id: string;
  linkedin_post_id: string;
  post_url: string | null;
  posted_at: string | null;
  scraped_at: string;
  text: string | null;
  reactions: number;
  comments: number;
  reposts: number;
  media_type: "none" | "image" | "video" | "document" | string;
  media_urls: string[];
  visual_kind: "photo" | "graphic" | null;
  is_viral: boolean;
  viral_score: number | null;
};

export type Template = {
  id: string;
  post_id: string;
  template_text: string;
  structure: unknown;
  model: string | null;
  generated_at: string;
};

export type Client = {
  id: string;
  name: string;
  brand_colors: { name?: string; hex: string }[];
  notes: string | null;
  logo_url: string | null;
  font_primary: string | null;
  font_secondary: string | null;
  created_at: string;
};
