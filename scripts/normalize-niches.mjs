// Normalize accounts.niche values to collapse casing/near-duplicates.
//
// Dry-run by default (prints what would change). Pass --apply to actually
// write to Supabase.
//
// Usage:
//   node scripts/normalize-niches.mjs          # preview
//   node scripts/normalize-niches.mjs --apply  # write changes

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
  if (!m) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SR) { console.error("Supabase env missing"); process.exit(1); }

const apply = process.argv.includes("--apply");

// Map keys are case-insensitive matches. Value is the canonical niche.
// Rules are evaluated top-to-bottom; first match wins.
const RULES = [
  // AI family — all AI-flavored niches collapse into a single "AI" bucket.
  // Includes: AI Automation, AI Automation / No-code, AI automation,
  // AI + LinkedIn, AI Ads, AI Agents, AI GTM, No-code, Video/AI.
  { match: /^ai\b.*$/i, to: "AI" },
  { match: /^no-?code$/i, to: "AI" },
  { match: /^video\s*\/?\s*ai$/i, to: "AI" },

  // Ads family — paid acquisition across channels.
  // Includes: Ads, Ads + UGC, Paid Ads, Google Ads, Meta Ads.
  { match: /^ads(\s*\+\s*ugc)?$/i, to: "Ads" },
  { match: /^(paid|google|meta)\s+ads$/i, to: "Ads" },

  // Outreach family — cold outbound across channels.
  // Includes: Cold Email, Cold Email / AI, Cold Email/GTM,
  // LinkedIn Outreach, Outreach, SMS, Lead Gen.
  { match: /^cold email(\s*\/?\s*(ai|gtm))?$/i, to: "Outreach" },
  { match: /^linkedin\s*\/?\s*cold email$/i, to: "Outreach" },
  { match: /^(linkedin\s+)?outreach$/i, to: "Outreach" },
  { match: /^sms$/i, to: "Outreach" },
  { match: /^lead\s+gen$/i, to: "Outreach" },

  // LinkedIn family — content/personal brand on LinkedIn.
  // Includes: LinkedIn, Agencies & LinkedIn, Personal Brand.
  { match: /^linkedin$/i, to: "LinkedIn" },
  { match: /^agencies?\s*&\s*linkedin$/i, to: "LinkedIn" },
  { match: /^personal\s+brand$/i, to: "LinkedIn" },

  // GTM / Marketing umbrella.
  // Includes: GTM, Marketing, Email Marketing.
  { match: /^gtm$/i, to: "GTM" },
  { match: /^marketing$/i, to: "GTM" },
  { match: /^email\s+marketing$/i, to: "GTM" },

  // Keep distinct: SEO, Agency Operations, Investor, GAMES.
];

function normalize(value) {
  const trimmed = value.trim();
  for (const r of RULES) {
    if (r.match.test(trimmed)) return r.to;
  }
  return trimmed; // unchanged
}

async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SR,
      Authorization: `Bearer ${SR}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

const accounts = await sb("GET", "accounts?select=id,name,niche&niche=not.is.null&order=niche");

const changes = [];
const tallyBefore = new Map();
const tallyAfter = new Map();
for (const a of accounts) {
  const before = a.niche;
  const after = normalize(before);
  tallyBefore.set(before, (tallyBefore.get(before) ?? 0) + 1);
  tallyAfter.set(after, (tallyAfter.get(after) ?? 0) + 1);
  if (before !== after) changes.push({ id: a.id, name: a.name, before, after });
}

console.log(`Scanned ${accounts.length} accounts with niche set.\n`);
console.log(`Distinct niches: ${tallyBefore.size} → ${tallyAfter.size}\n`);

if (changes.length === 0) {
  console.log("No changes needed. Niches already normalized.");
  process.exit(0);
}

console.log("Planned changes:");
for (const c of changes) {
  console.log(`  ${c.name.padEnd(35)} "${c.before}" → "${c.after}"`);
}
console.log("");

console.log("After this script runs, niche distribution will be:");
const sorted = Array.from(tallyAfter.entries()).sort((a, b) => b[1] - a[1]);
for (const [n, count] of sorted) console.log(`  ${String(count).padStart(3)}  ${n}`);
console.log("");

if (!apply) {
  console.log("Dry run. Re-run with --apply to write changes.");
  process.exit(0);
}

console.log(`Applying ${changes.length} updates…`);
let done = 0;
for (const c of changes) {
  await sb("PATCH", `accounts?id=eq.${c.id}`, { niche: c.after });
  done++;
  if (done % 5 === 0) console.log(`  ${done}/${changes.length}`);
}
console.log(`Done. Updated ${done} accounts.`);
