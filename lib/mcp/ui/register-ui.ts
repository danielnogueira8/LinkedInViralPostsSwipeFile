// Registers the three MCP Apps (SEP-1865) ui:// views: self-contained HTML
// resources that render tool results as SwipeIn-looking cards inside capable
// hosts (Claude, ChatGPT, VS Code). Hosts without the extension ignore the
// metadata and keep the tools' text JSON.
//
// The CSP resourceDomains are required — the default mcp-app CSP is
// img-src 'self' data:, which would block every LinkedIn CDN avatar/media
// image these cards render.

import type { McpServer } from "@modelcontextprotocol/server";
import { MCP_STABLE_CACHE_HINT } from "@/lib/mcp/cache-hints";
import { MCP_APP_MIME_TYPE } from "@/lib/mcp/swipe-file-app";
import { POST_CARDS_VIEW_HTML } from "./post-cards-view";
import { SAVED_POSTS_VIEW_HTML } from "./saved-posts-view";
import { DRAFTS_VIEW_HTML } from "./drafts-view";

export const POST_CARDS_RESOURCE_URI = "ui://swipein/post-cards";
export const SAVED_POSTS_RESOURCE_URI = "ui://swipein/saved-posts";
export const DRAFTS_RESOURCE_URI = "ui://swipein/drafts";

const VIEW_META = {
  ui: {
    prefersBorder: false,
    csp: {
      resourceDomains: ["https://media.licdn.com", "https://*.licdn.com"],
      connectDomains: [] as string[],
      frameDomains: [] as string[],
    },
  },
} as const;

type View = { name: string; title: string; description: string; uri: string; html: string };

const VIEWS: View[] = [
  {
    name: "SwipeIn Post Cards",
    title: "SwipeIn Post Cards",
    description:
      "Swipe File cards for post results — author, body, media, engagement, and virality.",
    uri: POST_CARDS_RESOURCE_URI,
    html: POST_CARDS_VIEW_HTML,
  },
  {
    name: "SwipeIn Saved Posts",
    title: "SwipeIn Saved Posts",
    description: "Bookmark cards for saved LinkedIn posts, with category and note.",
    uri: SAVED_POSTS_RESOURCE_URI,
    html: SAVED_POSTS_VIEW_HTML,
  },
  {
    name: "SwipeIn Drafts",
    title: "SwipeIn Drafts",
    description: "Posts-board cards for saved drafts — status, kind, and schedule chips.",
    uri: DRAFTS_RESOURCE_URI,
    html: DRAFTS_VIEW_HTML,
  },
];

export function registerUiViews(server: McpServer) {
  for (const view of VIEWS) {
    server.registerResource(
      view.name,
      view.uri,
      {
        title: view.title,
        description: view.description,
        mimeType: MCP_APP_MIME_TYPE,
        cacheHint: MCP_STABLE_CACHE_HINT,
        _meta: VIEW_META,
      },
      async () => ({
        contents: [
          {
            uri: view.uri,
            mimeType: MCP_APP_MIME_TYPE,
            text: view.html,
            _meta: VIEW_META,
          },
        ],
      }),
    );
  }
}
