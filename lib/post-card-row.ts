import type { PostType } from "@/lib/post-type";

/** Canonical data contract rendered by Swipe File-style post cards. */
export type PostCardRow = {
  id: string;
  text: string | null;
  post_url: string | null;
  posted_at: string | null;
  reactions: number;
  comments: number;
  reposts: number;
  media_type: string;
  media_urls: string[];
  visual_kind: "photo" | "graphic" | null;
  viral_score?: number | null;
  viral_basis?: "relative" | "flat_fallback" | "below_floor" | null;
  baseline_score?: number | null;
  post_type: PostType;
  accounts: {
    name: string;
    niche: string | null;
    linkedin_handle: string;
    profile_pic_url?: string | null;
    viral_post_count?: number | null;
    total_post_count?: number | null;
  } | null;
};
