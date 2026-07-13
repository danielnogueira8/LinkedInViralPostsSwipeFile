import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  const absolute = join(root, directory);
  return readdirSync(absolute).flatMap((name) => {
    const file = join(absolute, name);
    if (statSync(file).isDirectory()) return sourceFiles(relative(root, file));
    return /\.(?:ts|tsx)$/.test(name) ? [file] : [];
  });
}

function importedModules(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const modules: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      modules.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      modules.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return modules;
}

function resolvedLocalImport(file: string, specifier: string): string | null {
  const absolute = specifier.startsWith("@/")
    ? join(root, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(file), specifier)
      : null;
  return absolute?.replace(/\.(?:ts|tsx)$/, "") ?? null;
}

function importersOf(files: string[], target: string): string[] {
  const targetPath = join(root, target).replace(/\.(?:ts|tsx)$/, "");
  return files
    .filter((file) =>
      importedModules(file).some(
        (specifier) => resolvedLocalImport(file, specifier) === targetPath,
      ),
    )
    .map((file) => relative(root, file));
}

describe("public architecture boundaries", () => {
  it("keeps the agent runtime loop behind the public agent module", () => {
    const files = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("evals")]
      .filter((file) => !file.endsWith("lib/agent/index.ts"));
    expect(importersOf(files, "lib/agent/run.ts")).toEqual([]);
    const publicModule = readFileSync(join(root, "lib/agent/index.ts"), "utf8");
    expect(publicModule).not.toMatch(/export\s+\*/);
    expect(publicModule).toContain("runAgent");
  });

  it("tests weekly batch through start, run, and status rather than internals", () => {
    expect(importersOf(sourceFiles("evals"), "lib/batch/weekly.ts")).toEqual([]);
    const contract = readFileSync(join(root, "evals/data/weekly-batch-domain.test.ts"), "utf8");
    expect(contract).toContain(".start(");
    expect(contract).toContain(".run(");
    expect(contract).toContain(".status(");
  });

  it("keeps route helper behavior on the ChatTurn interface", () => {
    const routeImporters = importersOf(
      sourceFiles("evals/data").filter(
        (file) => !file.endsWith("architecture-boundaries.test.ts"),
      ),
      "app/api/chats/[id]/stream/route.ts",
    );
    expect(routeImporters).toEqual(["evals/data/chat-stream-preflight.test.ts"]);
    const integration = readFileSync(join(root, routeImporters[0]), "utf8");
    expect(integration).toContain('const { POST } = await import("@/app/api/chats/[id]/stream/route")');
    expect(integration).toContain('await import("@/lib/agent/chat-turn")');
  });

  it("keeps SSE consumption on ChatSession instead of the React workspace", () => {
    const workspace = readFileSync(join(root, "app/(app)/dashboard/chat-workspace.tsx"), "utf8");
    expect(workspace).not.toMatch(/export async function consumeSSE/);
    const contract = readFileSync(join(root, "evals/data/sse-overlay.test.ts"), "utf8");
    expect(contract).toContain('from "@/lib/chat-session"');
  });

  it("keeps tests out of the React workspace implementation", () => {
    expect(
      importersOf(sourceFiles("evals"), "app/(app)/dashboard/chat-workspace.tsx"),
    ).toEqual([]);
  });

  it("retains interface-level coverage for the extracted domains", () => {
    const expectedImports: Array<[string, string]> = [
      ["tracked-creators.test.ts", "@/lib/tracked-creators"],
      ["draft-lifecycle.test.ts", "@/lib/draft-lifecycle"],
      ["publishing-connection.test.ts", "@/lib/publishing"],
      ["chat-turn-lifecycle.test.ts", "@/lib/agent/chat-turn-lifecycle"],
      ["chat-session.test.ts", "@/lib/chat-session"],
      ["weekly-batch-domain.test.ts", "@/lib/batch/weekly-batch"],
    ];
    for (const [file, moduleName] of expectedImports) {
      expect(readFileSync(join(root, "evals/data", file), "utf8"), file).toContain(moduleName);
    }
  });
});
