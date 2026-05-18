// One-shot: hit Apify for a single LinkedIn handle and dump the full author
// object so we can see which field has the profile picture. Costs 1 result.
//
// Usage: node scripts/inspect-author.mjs <handle>
// Example: node scripts/inspect-author.mjs zach-schieffer

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Tiny .env.local loader so we don't pull in a dep.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
  if (!m) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

const handle = process.argv[2] || "zach-schieffer";
const actor = process.env.APIFY_ACTOR_ID || "apimaestro~linkedin-profile-posts";
const token = process.env.APIFY_API_TOKEN;
if (!token) { console.error("APIFY_API_TOKEN missing"); process.exit(1); }

const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}`;
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: handle, limit: 1, page_number: 1 }),
});
if (!res.ok) { console.error("apify HTTP", res.status); process.exit(1); }
const items = await res.json();
const first = Array.isArray(items) ? items[0] : null;
if (!first) { console.error("no items"); process.exit(1); }

console.log("=== TOP-LEVEL KEYS ===");
console.log(Object.keys(first));
console.log("\n=== AUTHOR OBJECT (full) ===");
console.log(JSON.stringify(first.author, null, 2));
