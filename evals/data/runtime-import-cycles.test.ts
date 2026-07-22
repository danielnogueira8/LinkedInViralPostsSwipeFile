import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const root = process.cwd();

function resolveLocalImport(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(root, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Set<string>();
  const addTarget = (specifier: string) => {
    const target = resolveLocalImport(file, specifier);
    if (target) imports.add(target);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const namedBindingsAreTypeOnly =
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly);
      if (!clause?.isTypeOnly && !namedBindingsAreTypeOnly) {
        addTarget(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const namedExportsAreTypeOnly =
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly);
      if (!node.isTypeOnly && !namedExportsAreTypeOnly) {
        addTarget(node.moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      addTarget(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      addTarget(node.arguments[0].text);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return [...imports];
}

function findRuntimeCycle(entry: string): string[] | null {
  const visiting: string[] = [];
  const visited = new Set<string>();

  const visit = (file: string): string[] | null => {
    const activeIndex = visiting.indexOf(file);
    if (activeIndex >= 0) return [...visiting.slice(activeIndex), file];
    if (visited.has(file)) return null;
    visiting.push(file);
    for (const dependency of runtimeImports(file)) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    visiting.pop();
    visited.add(file);
    return null;
  };

  return visit(join(root, entry))?.map((file) => relative(root, file)) ?? null;
}

describe("runtime import graph", () => {
  test.each([
    "lib/agent/rate-limit.ts",
    "lib/agent/execute/writer.ts",
  ])("%s has no reachable runtime cycle", (entry) => {
    expect(findRuntimeCycle(entry)).toBeNull();
  });
});
