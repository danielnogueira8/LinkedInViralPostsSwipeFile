import { SWIPEIN_MCP_INSTRUCTIONS } from "@/lib/mcp/llms-instructions";

export function GET() {
  return new Response(SWIPEIN_MCP_INSTRUCTIONS, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
