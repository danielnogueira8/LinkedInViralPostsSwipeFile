import { createClient, SupabaseClient } from "@supabase/supabase-js";

let serverClient: SupabaseClient | null = null;

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
