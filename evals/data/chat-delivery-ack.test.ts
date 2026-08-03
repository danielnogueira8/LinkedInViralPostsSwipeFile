import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { createChatDeliveryAcknowledgement } from "@/lib/chat-delivery-ack";

describe("chat delivery acknowledgement", () => {
  test("reports the first accepted stream exactly once", () => {
    const delivered = vi.fn();
    const acknowledgement = createChatDeliveryAcknowledgement(delivered);

    acknowledgement.accept();
    acknowledgement.reject();

    expect(delivered).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledWith(true);
  });

  test("reports a pre-stream rejection without later flipping to accepted", () => {
    const delivered = vi.fn();
    const acknowledgement = createChatDeliveryAcknowledgement(delivered);

    acknowledgement.reject();
    acknowledgement.accept();

    expect(delivered).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledWith(false);
  });

  test("Ask and Interview cards only lock after accepted delivery", () => {
    const source = readFileSync(
      "app/(app)/dashboard/chat-workspace.tsx",
      "utf8",
    );
    const askStart = source.indexOf("function AskCard(");
    const interviewStart = source.indexOf("function InterviewCard(");
    const askSource = source.slice(askStart, interviewStart);
    const interviewSource = source.slice(interviewStart);
    const askAwait = askSource.indexOf("await onSubmit(");
    const askLock = askSource.indexOf("if (delivered)");
    const interviewAwait = interviewSource.indexOf("await onSubmit(");
    const interviewLock = interviewSource.indexOf(
      "if (delivered) setSubmitted(true)",
    );
    const streamStart = source.indexOf("streamStarted = true;");
    const streamAccept = source.indexOf("delivery.accept();");

    for (const index of [
      askAwait,
      askLock,
      interviewAwait,
      interviewLock,
      streamStart,
      streamAccept,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(askAwait).toBeLessThan(askLock);
    expect(interviewAwait).toBeLessThan(interviewLock);
    expect(streamStart).toBeLessThan(streamAccept);
    expect(source).toContain(
      "key={askMessageAliases.get(m.id) ?? m.id}",
    );
    expect(source).toContain("await canonicalAssistantIdForAsk(");
    const alias = source.indexOf(
      "setAskMessageAliases((current) =>",
    );
    const atomicSwap = source.indexOf(
      "askTurn.complete(canonicalMessages, canonicalArtifacts)",
    );
    expect(alias).toBeGreaterThanOrEqual(0);
    expect(atomicSwap).toBeGreaterThan(alias);
    expect(source).toContain(
      "overrideText === undefined &&\n            failedChatIsActive",
    );
  });
});
