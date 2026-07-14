import { afterEach, describe, expect, test, vi } from "vitest";
import {
  chatSetupDeadlines,
  createChatSetupDeadline,
  waitForChatSetup,
} from "@/lib/chat-stream-policy";

afterEach(() => vi.useRealTimers());

describe("chat pre-stream setup policy", () => {
  test("keeps the client deadline after the server claim-release deadline", () => {
    for (const work of [
      { hasImageAttachment: false, createsLeadMagnet: false },
      { hasImageAttachment: true, createsLeadMagnet: false },
      { hasImageAttachment: false, createsLeadMagnet: true },
    ]) {
      const deadlines = chatSetupDeadlines(work);
      expect(deadlines.clientMs).toBeGreaterThan(deadlines.serverMs);
      expect(deadlines.clientMs).toBeLessThan(300_000);
    }
  });

  test("allows bounded image and lead-magnet setup more time than ordinary chat", () => {
    const normal = chatSetupDeadlines({
      hasImageAttachment: false,
      createsLeadMagnet: false,
    });
    const image = chatSetupDeadlines({
      hasImageAttachment: true,
      createsLeadMagnet: false,
    });
    const leadMagnet = chatSetupDeadlines({
      hasImageAttachment: false,
      createsLeadMagnet: true,
    });
    expect(image.serverMs).toBeGreaterThan(normal.serverMs);
    expect(leadMagnet.serverMs).toBeGreaterThan(image.serverMs);
  });

  test("aborts setup when the server deadline expires", async () => {
    vi.useFakeTimers();
    const deadline = createChatSetupDeadline(50);

    await vi.advanceTimersByTimeAsync(50);

    expect(deadline.didExpire()).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
  });

  test("stops waiting for a signal-unaware setup operation", async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => {});
    const result = waitForChatSetup(never, controller.signal);

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
