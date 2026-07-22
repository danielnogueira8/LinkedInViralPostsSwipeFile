import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  errorResponse,
  INTERNAL_ERROR_MESSAGE,
  NoWorkspaceError,
} from "@/lib/workspace";

describe("API error envelopes", () => {
  it("returns 401 with the stable envelope when no session exists", async () => {
    const response = errorResponse(new NoWorkspaceError());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "You're not signed in.",
    });
  });

  it("logs internal failures without returning their details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = errorResponse(
      new Error("postgres password=secret host=internal.example"),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: INTERNAL_ERROR_MESSAGE,
    });
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("does not reflect raw failure details from route-level 500 responses", () => {
    const routeFiles: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name === "route.ts") routeFiles.push(path);
      }
    };
    walk("app/api");

    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must centralize helper-based 500 responses`).not.toMatch(
        /jsonError\([\s\S]{0,200}?,\s*500\s*\)/,
      );
      for (const match of source.matchAll(/status:\s*500/g)) {
        const response = source.slice(Math.max(0, match.index - 450), match.index);
        expect(response, `${file} must not reflect an exception message`).not.toMatch(
          /(?:\.message|\.reason|details:)\s*[,}]/,
        );
      }
    }
  });
});
