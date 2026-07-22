import { afterEach, describe, expect, test, vi } from "vitest";
import {
  clearCoworkDestination,
  readCoworkDestination,
  shouldRestoreAgentDestination,
  writeCoworkDestination,
} from "@/lib/cowork-destination";

afterEach(() => vi.unstubAllGlobals());

describe("shouldRestoreAgentDestination", () => {
  test("restores Your Agent when returning to a bare Cowork route", () => {
    expect(
      shouldRestoreAgentDestination({
        savedDestination: "agent",
        hasExplicitDestination: false,
      }),
    ).toBe(true);
  });

  test("never overrides an explicit chat or modeling destination", () => {
    expect(
      shouldRestoreAgentDestination({
        savedDestination: "agent",
        hasExplicitDestination: true,
      }),
    ).toBe(false);
  });

  test("does not restore Your Agent when a chat was the last Cowork destination", () => {
    expect(
      shouldRestoreAgentDestination({
        savedDestination: null,
        hasExplicitDestination: false,
      }),
    ).toBe(false);
  });

  test("persists only the Agent destination for the current browser session", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    writeCoworkDestination("agent");
    expect(readCoworkDestination()).toBe("agent");
    clearCoworkDestination();
    expect(readCoworkDestination()).toBeNull();
  });
});
