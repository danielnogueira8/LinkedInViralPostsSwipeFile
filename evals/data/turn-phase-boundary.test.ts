import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) =>
  readFileSync(join(root, path), "utf8");

describe("executeChatTurn phase boundary", () => {
  it("keeps setup state private from downstream phase implementations", () => {
    for (const phase of ["compile", "execute", "finalize"]) {
      const contents = source(`lib/agent/turn/${phase}.ts`);
      expect(contents).not.toContain('from "@/lib/agent/turn/setup"');
      expect(contents).toContain('from "@/lib/agent/turn/state"');
    }
  });

  it("keeps shared phase state independent of phase implementations", () => {
    const contents = source("lib/agent/turn/state.ts");
    for (const implementation of [
      "chat-turn",
      "setup",
      "compile",
      "execute",
      "finalize",
    ]) {
      expect(contents).not.toContain(
        `from "@/lib/agent/turn/${implementation}"`,
      );
    }
  });

  it("preserves executeChatTurn as the public phase orchestrator", () => {
    const contents = source("lib/agent/chat-turn.ts");
    expect(contents).toMatch(
      /setupChatTurn\([\s\S]*compileTurnPlan\([\s\S]*executeTurnPlan\([\s\S]*finalizeTurn\(/,
    );
  });
});
