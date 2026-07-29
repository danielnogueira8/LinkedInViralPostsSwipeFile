import { describe, expect, test, vi } from "vitest";

process.env.CREDENTIAL_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({ from: () => ({}) }),
}));

vi.mock("@/lib/supabase-scoped", () => ({
  latestRelevantScrapeForService: async () => null,
  trackedAccountIdsForService: async () => [],
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");
const {
  SWIPE_FILE_APP_RESOURCE_URI,
  registerSwipeFileAppResource,
} = await import("@/lib/mcp/swipe-file-app");
const { SWIPE_FILE_APP_HTML } = await import(
  "@/lib/mcp/swipe-file-app.generated"
);

describe("Swipe File MCP App", () => {
  test("ships executable JavaScript instead of corrupting the bundle during HTML injection", () => {
    const script = SWIPE_FILE_APP_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  test("links the existing search tool to the interactive app resource", () => {
    const tools = new Map<string, Record<string, unknown>>();
    registerSwipeTools({
      registerTool: (name: string, config: Record<string, unknown>) => {
        tools.set(name, config);
      },
    } as never);

    expect(tools.get("search_viral_posts")).toMatchObject({
      _meta: {
        ui: {
          resourceUri: SWIPE_FILE_APP_RESOURCE_URI,
          visibility: ["model", "app"],
        },
        "ui/resourceUri": SWIPE_FILE_APP_RESOURCE_URI,
      },
    });
    expect(SWIPE_FILE_APP_RESOURCE_URI).toContain("swipe-file-v3");
  });

  test("serves one self-contained, sandboxed HTML app resource", async () => {
    let resource:
      | {
          uri: string;
          config: Record<string, unknown>;
          read: () => Promise<{
            contents: Array<{
              uri: string;
              mimeType?: string;
              text?: string;
              _meta?: Record<string, unknown>;
            }>;
          }>;
        }
      | undefined;

    registerSwipeFileAppResource({
      registerResource: (
        _name: string,
        uri: string,
        config: Record<string, unknown>,
        read: typeof resource extends { read: infer T } ? T : never,
      ) => {
        resource = { uri, config, read } as NonNullable<typeof resource>;
      },
    } as never);

    expect(resource?.uri).toBe(SWIPE_FILE_APP_RESOURCE_URI);
    const result = await resource!.read();
    expect(result.contents[0]).toMatchObject({
      uri: SWIPE_FILE_APP_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
    });
    expect(result.contents[0].text).toContain("Model this post");
    expect(result.contents[0].text).toContain("search_viral_posts");
    expect(result.contents[0].text).toContain("untrusted content");
    expect(result.contents[0].text).toContain(".linkedin.com");
    expect(result.contents[0].text).toContain("Previous post");
    expect(result.contents[0].text).toContain("Next post");
    expect(result.contents[0].text).toContain("aria-roledescription");
    expect(result.contents[0].text).toContain("carousel");
    expect(result.contents[0].text).toContain("Original post media");
    expect(result.contents[0].text).toContain("profile_pic_url");
    expect(result.contents[0].text).toContain("avatar-image");
    expect(result.contents[0].text).toContain("Image unavailable");
    expect(result.contents[0].text).toContain("carousel-position");
    expect(result.contents[0]._meta).toMatchObject({
      ui: {
        csp: {
          resourceDomains: ["https://*.licdn.com"],
        },
      },
    });
  });
});
