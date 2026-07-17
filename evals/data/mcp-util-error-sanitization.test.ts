import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dbErrorContent, notFoundContent } from "@/lib/mcp/util";

// Bug-hunt fix: MCP list/create/insert tool handlers used to forward raw
// PostgrestError.message (which can name real schema/column/constraint
// internals) straight to the calling MCP client via errorContent(error.message).
// dbErrorContent is the sanitized replacement — logs the real error
// server-side (still debuggable) and returns a generic message to the caller,
// mirroring notFoundContent's existing sanitization for id-lookup errors.
describe("mcp/util — dbErrorContent (DB-error sanitization)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test("never leaks the raw error message to the caller", () => {
    const raw = new Error(
      'invalid input syntax for type uuid: "not-a-uuid", column "workspace_accounts.account_id" does not exist',
    );
    const result = dbErrorContent("list_accounts", raw);
    const text = result.content[0].text;

    expect(text).not.toContain("workspace_accounts");
    expect(text).not.toContain("account_id");
    expect(text).not.toContain("invalid input syntax");
    expect(result.isError).toBe(true);
  });

  test("returns a generic, stable message regardless of error shape", () => {
    const fromError = dbErrorContent("get_top_from_batch", new Error("boom"));
    const fromString = dbErrorContent("get_top_from_batch", "plain string error");
    const fromUnknown = dbErrorContent("get_top_from_batch", { weird: "shape" });

    expect(fromError.content[0].text).toBe(fromString.content[0].text);
    expect(fromError.content[0].text).toBe(fromUnknown.content[0].text);
    expect(JSON.parse(fromError.content[0].text)).toMatchObject({
      ok: false,
      error: "Something went wrong processing that request.",
    });
  });

  test("logs the real error server-side, tagged with the tool context", () => {
    const raw = new Error("the real internal error");
    dbErrorContent("save_post", raw);

    expect(consoleErrorSpy).toHaveBeenCalledWith("[mcp:save_post]", raw);
  });
});

describe("mcp/util — notFoundContent (existing sibling sanitization, still intact)", () => {
  test("still returns a clean not_found envelope (regression guard)", () => {
    const result = notFoundContent("Draft", "abc-123");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      ok: false,
      code: "not_found",
      error: "Draft not found",
      id: "abc-123",
    });
    expect(result.isError).toBe(true);
  });
});
