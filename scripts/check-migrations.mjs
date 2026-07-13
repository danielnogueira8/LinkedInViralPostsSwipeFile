import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const write = args.includes("--write");
const dirArg = args.find((arg) => arg.startsWith("--dir="));
const dbDir = path.resolve(dirArg ? dirArg.slice(6) : "db");
const pattern = /^migration-(\d{3})-[a-z0-9][a-z0-9-]*\.sql$/;

const names = (await readdir(dbDir))
  .filter((name) => name.startsWith("migration-") && name.endsWith(".sql"))
  .sort();
const invalid = names.filter((name) => !pattern.test(name));
if (invalid.length) fail(`invalid migration name(s): ${invalid.join(", ")}`);

const entries = names.map((name) => ({ name, version: Number(pattern.exec(name)[1]) }));
const versions = entries.map((entry) => entry.version);
if (versions.some((version) => version < 1)) fail("migration versions must start at 001");
const duplicate = versions.find((version, index) => versions.indexOf(version) !== index);
if (duplicate) fail(`duplicate migration version: ${String(duplicate).padStart(3, "0")}`);
for (let expected = 1; expected <= versions.at(-1); expected += 1) {
  if (!versions.includes(expected)) fail(`missing migration version: ${String(expected).padStart(3, "0")}`);
}

for (const entry of entries) {
  const sql = await readFile(path.join(dbDir, entry.name), "utf8");
  validateSqlStructure(entry.name, sql);
}

const highest = entries.at(-1);
if (highest && highest.version >= 87) {
  const sql = await readFile(path.join(dbDir, highest.name), "utf8");
  const code = stripNonCode(sql.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)?\$[\s\S]*?\$\1\$/g, ""));
  const marker = new RegExp(
    `insert\\s+into\\s+(?:public\\.)?app_schema_version\\s*\\([^)]*\\)\\s*values\\s*\\(\\s*true\\s*,\\s*${highest.version}\\s*,`,
    "i",
  );
  if (!marker.test(code)) fail(`${highest.name} must advance app_schema_version to ${highest.version}`);
}

const metadata = {
  generatedBy: "npm run migrations:metadata",
  highest: versions.at(-1) ?? 0,
  count: entries.length,
  files: entries.map((entry) => entry.name),
};
const metadataPath = path.join(dbDir, "migrations.json");
const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
if (write) {
  await writeFile(metadataPath, serialized);
  console.log(`wrote ${metadataPath} (schema version ${metadata.highest})`);
} else {
  let current = "";
  try { current = await readFile(metadataPath, "utf8"); } catch { /* diagnosed below */ }
  if (current !== serialized) fail("db/migrations.json is stale; run npm run migrations:metadata");
  console.log(`migration chain valid: 001..${String(metadata.highest).padStart(3, "0")} (${metadata.count} files)`);
}

function fail(message) {
  console.error(`migration check failed: ${message}`);
  process.exit(1);
}


function validateSqlStructure(name, sql) {
  const dollar = /\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/g;
  let cursor = 0;
  let match;
  while ((match = dollar.exec(sql))) {
    validatePlainSql(name, sql.slice(cursor, match.index));
    const close = sql.indexOf(match[0], dollar.lastIndex);
    if (close === -1) fail(`unterminated dollar quote in ${name}`);
    validatePlainSql(name, sql.slice(dollar.lastIndex, close));
    cursor = close + match[0].length;
    dollar.lastIndex = cursor;
  }
  validatePlainSql(name, sql.slice(cursor));
}

function validatePlainSql(name, sql) {
  const stripped = stripNonCode(sql);
  let depth = 0;
  for (const char of stripped) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) fail(`unbalanced parentheses in ${name}`);
  }
  if (depth !== 0) fail(`unbalanced parentheses in ${name}`);
}

function stripNonCode(sql) {
  let output = "";
  for (let index = 0; index < sql.length;) {
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      index = end === -1 ? sql.length : end;
    } else if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) fail("unterminated block comment");
      index = end + 2;
    } else if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index];
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) index += 2;
        else if (sql[index] === quote) { index += 1; closed = true; break; }
        else index += 1;
      }
      if (!closed) fail(`unterminated ${quote === "'" ? "string" : "identifier"} quote`);
    } else {
      output += sql[index];
      index += 1;
    }
  }
  return output;
}
