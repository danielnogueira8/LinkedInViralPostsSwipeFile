import { describe, expect, test, vi } from "vitest";
import { requestServerTurnStop } from "@/lib/chat-stop";

describe("client Stop confirmation", () => {
  test("retries a pre-header Stop until the client turn identity is claimed", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const wait = vi.fn(async () => undefined);

    await requestServerTurnStop(
      {
        chatId: "chat-1",
        identity: {
          clientTurnId: "00000000-0000-4000-8000-000000000701",
        },
      },
      { fetcher, retryDelaysMs: [0, 10, 20], wait },
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      clientTurnId: "00000000-0000-4000-8000-000000000701",
    });
  });

  test("surfaces an unconfirmed Stop after bounded retries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));

    await expect(
      requestServerTurnStop(
        {
          chatId: "chat-1",
          identity: {
            clientTurnId: "00000000-0000-4000-8000-000000000701",
          },
        },
        {
          fetcher,
          retryDelaysMs: [0, 0, 0],
          wait: async () => undefined,
        },
      ),
    ).rejects.toThrow(/could not confirm/i);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test("a hung Stop request reaches the visible failure path within a bound", async () => {
    const fetcher = vi.fn<typeof fetch>(
      () => new Promise<Response>(() => undefined),
    );

    await expect(
      requestServerTurnStop(
        {
          chatId: "chat-1",
          identity: {
            clientTurnId: "00000000-0000-4000-8000-000000000701",
          },
        },
        {
          attemptTimeoutMs: 2,
          fetcher,
          retryDelaysMs: [0, 0],
          wait: async () => undefined,
        },
      ),
    ).rejects.toThrow(/could not confirm/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
