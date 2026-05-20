// Restore accounts.niche for rows where it's NULL by asking Claude Haiku to
// classify each account into one of the 9 canonical niches, based on the
// account's name, headline, and a handful of recent post snippets.
//
// Dry-run by default. Pass --apply to write.
//
// Usage:
//   node scripts/restore-niches.mjs                 # preview all null-niche accounts
//   node scripts/restore-niches.mjs --apply         # write
//   node scripts/restore-niches.mjs --limit 5       # only do 5 (for sanity-checking)
//   node scripts/restore-niches.mjs --limit 5 --apply

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

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
const ANTHROPIC_KEY = process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
if (!SUPABASE_URL || !SR) { console.error("Supabase env missing"); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error("Anthropic key missing"); process.exit(1); }

const apply = process.argv.includes("--apply");
const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;

const NICHES = ["AI", "Automation", "Ads", "Outreach", "LinkedIn", "LinkedIn Content", "GTM", "SEO", "Agency Operations", "Investor"];

const SYSTEM = `You classify LinkedIn creators into ONE of these 10 niches based on their content:

- AI — AI automation, AI agents, no-code, AI tooling, AI consulting
- Automation — non-AI workflow automation (Zapier, n8n, ops automation)
- Ads — paid acquisition (Meta Ads, Google Ads, paid social, UGC ads)
- Outreach — cold email, cold outbound, LinkedIn outreach, SMS, lead gen
- LinkedIn — personal brand, LinkedIn-as-a-channel for founders/operators, organic LinkedIn growth
- LinkedIn Content — the craft/service of writing LinkedIn content (ghostwriting, content ops)
- GTM — go-to-market, marketing strategy, email marketing, general marketing
- SEO — search engine optimization, content SEO, technical SEO
- Agency Operations — running/scaling agencies, ops, team building, hiring
- Investor — VC, angel investing, fundraising, finance

Reply with ONLY the niche name, exactly as written above. No punctuation, no explanation.`;

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

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

async function classify(account, posts) {
  const postSnippets = posts
    .slice(0, 3)
    .map((p) => (p.text || "").slice(0, 400))
    .filter(Boolean)
    .join("\n\n---\n\n");
  const userContent = [
    `Name: ${account.name}`,
    account.headline ? `Headline: ${account.headline}` : null,
    postSnippets ? `Recent posts:\n${postSnippets}` : "Recent posts: (none available)",
  ].filter(Boolean).join("\n\n");

  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 32,
    system: SYSTEM,
    messages: [{ role: "user", content: userContent }],
  });
  const block = res.content[0];
  if (block.type !== "text") return null;
  const guess = block.text.trim();
  return NICHES.includes(guess) ? guess : null;
}

let query = "accounts?select=id,name,headline,profile_url&niche=is.null&order=name";
if (limit) query += `&limit=${limit}`;
const accounts = await sb("GET", query);

console.log(`Found ${accounts.length} accounts with niche IS NULL.\n`);
if (accounts.length === 0) process.exit(0);

const results = [];
let i = 0;
for (const a of accounts) {
  i++;
  const posts = await sb(
    "GET",
    `posts?select=text&account_id=eq.${a.id}&order=reactions.desc&limit=3`,
  );
  let guess = null;
  try {
    guess = await classify(a, posts);
  } catch (e) {
    console.log(`  [${i}/${accounts.length}] ${a.name.padEnd(35)} ERROR: ${e.message}`);
    continue;
  }
  if (!guess) {
    console.log(`  [${i}/${accounts.length}] ${a.name.padEnd(35)} (no confident guess)`);
    continue;
  }
  results.push({ id: a.id, name: a.name, niche: guess });
  console.log(`  [${i}/${accounts.length}] ${a.name.padEnd(35)} → ${guess}`);
}

console.log("");
const tally = new Map();
for (const r of results) tally.set(r.niche, (tally.get(r.niche) ?? 0) + 1);
const sorted = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]);
console.log("Distribution:");
for (const [n, c] of sorted) console.log(`  ${String(c).padStart(3)}  ${n}`);
console.log("");

const reportPath = resolve(__dirname, "restore-niches-report.json");
writeFileSync(reportPath, JSON.stringify(results, null, 2));
console.log(`Wrote full plan to ${reportPath}`);

if (!apply) {
  console.log("\nDry run. Review the report, then re-run with --apply to write.");
  process.exit(0);
}

console.log(`\nApplying ${results.length} updates…`);
let done = 0;
for (const r of results) {
  await sb("PATCH", `accounts?id=eq.${r.id}`, { niche: r.niche });
  done++;
  if (done % 10 === 0) console.log(`  ${done}/${results.length}`);
}
console.log(`Done. Updated ${done} accounts.`);
