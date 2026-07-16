import { beforeEach, describe, expect, test, vi } from "vitest";

const { success, error } = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success, error } }));

import { copyToClipboard } from "@/lib/clipboard";

describe("copyToClipboard", () => {
  beforeEach(() => {
    success.mockClear();
    error.mockClear();
  });

  test("reports success only after the browser accepts the copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyToClipboard("post", "Post copied")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("post");
    expect(success).toHaveBeenCalledWith("Post copied");
    expect(error).not.toHaveBeenCalled();
  });

  test("returns false and shows actionable feedback when copying fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyToClipboard("post")).resolves.toBe(false);
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Couldn't copy — copy it manually");
  });
});
