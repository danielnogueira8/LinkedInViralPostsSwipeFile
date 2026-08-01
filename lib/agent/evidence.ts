import type { CitedPost } from "@/lib/cite-resolve";

export const MAX_GROUNDED_ANSWER_RESULTS = 10;

export type GroundedSource = {
  id: string;
  kind: "news" | "web" | "workspace_post" | "attachment";
  text: string;
  title?: string;
  url?: string;
  publishedAt?: string;
  author?: string;
  metrics?: {
    reactions?: number;
    comments?: number;
    reposts?: number;
  };
  /**
   * Ephemeral, server-verified preview for the just-finished live turn.
   * Persistence strips this snapshot and reloads fresh workspace-scoped data.
   */
  card?: CitedPost;
};
