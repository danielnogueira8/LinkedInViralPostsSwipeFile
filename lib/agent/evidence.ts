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
};
