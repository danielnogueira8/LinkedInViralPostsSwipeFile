import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatCronAlert, postCronAlert } from "@/lib/cron-alert";

describe("formatCronAlert", () => {
  test("prefixes the cron name and includes the message", () => {
    const out = formatCronAlert({ cron: "publish-scheduled" }, "boom");
    expect(out).toContain("publish-scheduled");
    expect(out).toContain("boom");
    expect(out.startsWith("🔴")).toBe(true);
  });

  test("includes optional detail on its own line", () => {
    const out = formatCronAlert({ cron: "jobs", detail: "3 stuck" }, "boom");
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("3 stuck");
  });

  test("truncates a very long error message", () => {
    const out = formatCronAlert({ cron: "jobs" }, "x".repeat(1000));
    // header + 500-char message line
    expect(out.split("\n")[1]).toHaveLength(500);
  });
});

describe("postCronAlert", () => {
  const origWebhook = process.env.HEALTH_DIGEST_WEBHOOK;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (origWebhook === undefined) delete process.env.HEALTH_DIGEST_WEBHOOK;
    else process.env.HEALTH_DIGEST_WEBHOOK = origWebhook;
  });

  test("no-ops (no fetch) when no webhook is configured", async () => {
    delete process.env.HEALTH_DIGEST_WEBHOOK;
    const sent = await postCronAlert({ cron: "jobs" }, new Error("boom"));
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("POSTs the formatted alert to the webhook", async () => {
    process.env.HEALTH_DIGEST_WEBHOOK = "https://hook.example/x";
    fetchMock.mockResolvedValue({ ok: true });
    const sent = await postCronAlert({ cron: "publish-scheduled" }, new Error("kaboom"));
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hook.example/x");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.text).toContain("publish-scheduled");
    expect(body.text).toContain("kaboom");
  });

  test("returns false when the webhook rejects the alert with a non-2xx status", async () => {
    process.env.HEALTH_DIGEST_WEBHOOK = "https://hook.example/x";
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(
      postCronAlert({ cron: "publish-scheduled" }, new Error("kaboom")),
    ).resolves.toBe(false);
  });

  test("swallows a webhook failure and returns false (never throws)", async () => {
    process.env.HEALTH_DIGEST_WEBHOOK = "https://hook.example/x";
    fetchMock.mockRejectedValue(new Error("network down"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      postCronAlert({ cron: "sweep-media" }, new Error("boom")),
    ).resolves.toBe(false);
    consoleErr.mockRestore();
  });

  test("accepts a non-Error thrown value", async () => {
    process.env.HEALTH_DIGEST_WEBHOOK = "https://hook.example/x";
    fetchMock.mockResolvedValue({ ok: true });
    await postCronAlert({ cron: "jobs" }, "string failure");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain("string failure");
  });
});
