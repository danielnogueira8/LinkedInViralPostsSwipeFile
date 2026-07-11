import { describe, expect, test } from "vitest";
import {
  PersonalWorkspaceSetupError,
  selectCanonicalPersonalWorkspace,
} from "@/lib/personal-workspace";

const membership = (id: string, createdBy: string | null) => ({
  organization: { id, createdBy },
});

describe("selectCanonicalPersonalWorkspace", () => {
  test("selects the one organization created by the user", () => {
    expect(selectCanonicalPersonalWorkspace("user_1", [
      membership("org_foreign", "user_2"),
      membership("org_personal", "user_1"),
    ])).toBe("org_personal");
  });

  test("never falls back to a foreign or first membership", () => {
    expect(() => selectCanonicalPersonalWorkspace("user_1", [
      membership("org_foreign", "user_2"),
    ])).toThrow(PersonalWorkspaceSetupError);
  });

  test("rejects multiple personal organizations instead of choosing silently", () => {
    expect(() => selectCanonicalPersonalWorkspace("user_1", [
      membership("org_1", "user_1"),
      membership("org_2", "user_1"),
    ])).toThrow(/more than one personal workspace/i);
  });
});
