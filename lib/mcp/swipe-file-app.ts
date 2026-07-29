import type { McpServer } from "@modelcontextprotocol/server";
import { SWIPE_FILE_APP_HTML } from "./swipe-file-app.generated";

export const SWIPE_FILE_APP_RESOURCE_URI =
  "ui://swipein/swipe-file.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const SWIPE_FILE_APP_TOOL_META = {
  ui: {
    resourceUri: SWIPE_FILE_APP_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  // Older MCP Apps hosts still read the flat extension key.
  "ui/resourceUri": SWIPE_FILE_APP_RESOURCE_URI,
} as const;

export function registerSwipeFileAppResource(server: McpServer) {
  server.registerResource(
    "SwipeIn Swipe File",
    SWIPE_FILE_APP_RESOURCE_URI,
    {
      title: "SwipeIn Swipe File",
      description:
        "Interactive cards for reading, filtering, and modeling viral LinkedIn posts.",
      mimeType: MCP_APP_MIME_TYPE,
      _meta: {
        ui: {
          csp: {
            resourceDomains: ["https://media.licdn.com"],
          },
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: SWIPE_FILE_APP_RESOURCE_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: SWIPE_FILE_APP_HTML,
          _meta: {
            ui: {
              csp: {
                resourceDomains: ["https://media.licdn.com"],
              },
            },
          },
        },
      ],
    }),
  );
}

