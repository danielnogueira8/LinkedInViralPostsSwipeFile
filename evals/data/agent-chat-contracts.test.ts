import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, test } from "vitest";
import {
  AgentEventSchema,
  ArtifactSchema,
  AskQuestionSchema,
  PlanStepSchema,
} from "@/lib/agent/contracts";

describe("agent and chat contracts", () => {
  test("accepts the observable events shared by the runtime and client", () => {
    expect(
      AgentEventSchema.safeParse({
        type: "artifact",
        artifact: {
          id: "draft-1",
          kind: "post",
          title: "Draft",
          body: "A publishable post",
        },
      }).success,
    ).toBe(true);
    expect(
      AgentEventSchema.safeParse({
        type: "plan_update",
        steps: [{ id: "draft", label: "Draft the post", status: "active" }],
      }).success,
    ).toBe(true);
    expect(
      AgentEventSchema.safeParse({
        type: "done",
        message: {
          content: "Done",
          tool_calls: null,
          artifacts: [],
          toolMessages: [
            {
              role: "tool",
              content: "result",
              tool_call_id: "call-1",
            },
          ],
          inputTokens: 1,
          outputTokens: 1,
        },
      }).success,
    ).toBe(true);
  });

  test("rejects malformed artifacts, plans, questions, and events", () => {
    expect(
      ArtifactSchema.safeParse({
        id: "draft-1",
        kind: "post",
        title: "Draft",
        body: "   ",
      }).success,
    ).toBe(false);
    expect(
      ArtifactSchema.safeParse({
        id: "draft-1",
        kind: "post",
        title: "Draft",
        body: "A valid body",
        media_attachments: [{}],
      }).success,
    ).toBe(false);
    expect(
      PlanStepSchema.safeParse({ id: "draft", label: "", status: "active" }).success,
    ).toBe(false);
    expect(
      AskQuestionSchema.safeParse({
        question: "Which direction?",
        options: ["Only one"],
        allowOther: true,
      }).success,
    ).toBe(false);
    expect(AgentEventSchema.safeParse({ type: "text", delta: 42 }).success).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        type: "done",
        message: {
          content: "Done",
          tool_calls: null,
          artifacts: [],
          toolMessages: [{ role: "tool", content: "result" }],
          inputTokens: 1,
          outputTokens: 1,
        },
      }).success,
    ).toBe(false);
  });

  test("contract modules never depend on the runtime loop", () => {
    const source = readFileSync("lib/agent/contracts.ts", "utf8");
    const specialistSource = readFileSync(
      "lib/agent/specialists/contracts.ts",
      "utf8",
    );

    expect(source).not.toMatch(/from ["']@\/lib\/agent\/run["']/);
    expect(source).not.toMatch(/from ["']\.\/run["']/);
    expect(specialistSource).not.toMatch(/from ["']@\/lib\/agent\/run["']/);
  });

  test("the agent runtime is not part of an import cycle", () => {
    const files: string[] = [];
    const visitDirectory = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visitDirectory(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    visitDirectory("lib");

    const fileSet = new Set(files.map(normalize));
    const graph = new Map<string, string[]>();
    const resolveImport = (from: string, specifier: string): string | null => {
      const base = specifier.startsWith("@/")
        ? specifier.slice(2)
        : specifier.startsWith(".")
          ? normalize(join(dirname(from), specifier))
          : null;
      if (!base) return null;
      for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
        const normalized = normalize(candidate);
        if (existsSync(normalized) && fileSet.has(normalized)) return normalized;
      }
      return null;
    };

    for (const file of files) {
      const dependencies = Array.from(
        readFileSync(file, "utf8").matchAll(
          /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
        ),
      )
        .map((match) => resolveImport(file, match[1]))
        .filter((dependency): dependency is string => dependency !== null);
      graph.set(normalize(file), [...new Set(dependencies)]);
    }

    const runtime = normalize("lib/agent/run.ts");
    const reachesRuntime = (current: string, visited = new Set<string>()): boolean => {
      if (visited.has(current)) return false;
      visited.add(current);
      for (const dependency of graph.get(current) ?? []) {
        if (dependency === runtime) return true;
        if (reachesRuntime(dependency, visited)) return true;
      }
      return false;
    };

    for (const dependency of graph.get(runtime) ?? []) {
      expect(reachesRuntime(dependency), `${dependency} reaches ${runtime}`).toBe(false);
    }
  });
});
