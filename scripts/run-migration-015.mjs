// Apply migration-015 (collapse categories taxonomy) via PostgREST.
//
// We can't run raw SQL through PostgREST, so this script reproduces the
// migration step-by-step via REST calls. The SQL file in
// db/migration-015-collapse-categories.sql is the authoritative reference;
// keep them in sync if you tweak either.
//
// Usage:
//   node scripts/run-migration-015.mjs          # preview (no writes)
//   node scripts/run-migration-015.mjs --apply  # actually mutate

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
if (!SUPABASE_URL || !SR) {
  console.error("Supabase env missing");
  process.exit(1);
}

const apply = process.argv.includes("--apply");

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
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function log(label, value) {
  console.log(`  ${label.padEnd(40)} ${value}`);
}

// ---------- Niche normalization (mirrors migration-015 taxonomy rules) ----------
const NICHE_RULES = [
  { match: /^ai\b/i,                              niche: "AI",                category_id: "ai" },
  { match: /^no-?code$/i,                         niche: "AI",                category_id: "ai" },
  { match: /^video\s*\/?\s*ai$/i,                 niche: "AI",                category_id: "ai" },
  { match: /^ads(\s*\+\s*ugc)?$/i,                niche: "Ads",               category_id: "ads" },
  { match: /^(paid|google|meta)\s+ads$/i,         niche: "Ads",               category_id: "ads" },
  { match: /^cold\s+email(\s*\/?\s*(ai|gtm))?$/i, niche: "Outreach",          category_id: "outreach" },
  { match: /^linkedin\s*\/?\s*cold\s+email$/i,    niche: "Outreach",          category_id: "outreach" },
  { match: /^(linkedin\s+)?outreach$/i,           niche: "Outreach",          category_id: "outreach" },
  { match: /^sms$/i,                              niche: "Outreach",          category_id: "outreach" },
  { match: /^lead\s+gen$/i,                       niche: "Outreach",          category_id: "outreach" },
  { match: /^linkedin$/i,                         niche: "LinkedIn Content",  category_id: "linkedin-content" },
  { match: /^linkedin\s+content$/i,               niche: "LinkedIn Content",  category_id: "linkedin-content" },
  { match: /^agencies?\s*&\s*linkedin$/i,         niche: "LinkedIn Content",  category_id: "linkedin-content" },
  { match: /^personal\s+brand$/i,                 niche: "LinkedIn Content",  category_id: "linkedin-content" },
  { match: /^ghostwriting$/i,                     niche: "LinkedIn Content",  category_id: "linkedin-content" },
  { match: /^automation$/i,                       niche: "Automation",        category_id: "automation" },
  { match: /^gtm$/i,                              niche: "GTM",               category_id: "gtm" },
  { match: /^marketing$/i,                        niche: "GTM",               category_id: "gtm" },
  { match: /^email\s+marketing$/i,                niche: "GTM",               category_id: "gtm" },
  { match: /^seo$/i,                              niche: "SEO",               category_id: "seo" },
  { match: /^agency\s+operations$/i,              niche: "Agency Operations", category_id: "agency-operations" },
  { match: /^investor$/i,                         niche: "Investor",          category_id: "investor" },
];

function normalize(raw) {
  if (!raw) return null;
  const t = raw.trim();
  for (const r of NICHE_RULES) if (r.match.test(t)) return { niche: r.niche, category_id: r.category_id };
  return null;
}

console.log(`\nMigration 015 — collapse categories${apply ? "" : " (DRY RUN)"}`);
console.log("=".repeat(60));

// ---------- Step 1: re-point category_id='linkedin' to 'linkedin-content' ----------
const acctOnLinkedin = await sb(
  "GET",
  "accounts?select=id,name&category_id=eq.linkedin",
);
const wsOnLinkedin = await sb(
  "GET",
  "workspace_accounts?select=workspace_id,account_id&category_id=eq.linkedin",
);
console.log("\nStep 1 — re-point old `linkedin` category to `linkedin-content`");
log("accounts to update:", acctOnLinkedin.length);
log("workspace_accounts to update:", wsOnLinkedin.length);
if (apply && acctOnLinkedin.length > 0) {
  await sb("PATCH", "accounts?category_id=eq.linkedin", { category_id: "linkedin-content" });
}
if (apply && wsOnLinkedin.length > 0) {
  await sb("PATCH", "workspace_accounts?category_id=eq.linkedin", { category_id: "linkedin-content" });
}

// ---------- Step 2: delete ghost category rows ----------
const GHOSTS = [
  "linkedin",
  "linkedin-growth",
  "ai-automation",
  "gtm-outreach",
  "paid-ads",
  "personal-brand",
  "email-marketing",
  "agency-ops",
  "other",
];
console.log("\nStep 2 — delete ghost category rows");
for (const id of GHOSTS) log("delete category:", id);
if (apply) {
  // PostgREST `in` filter: in.(linkedin,linkedin-growth,...)
  const list = GHOSTS.join(",");
  await sb("DELETE", `categories?id=in.(${list})`);
}

// ---------- Step 3: assert canonical 9 with sort order ----------
const CANONICAL = [
  { id: "linkedin-content",  label: "LinkedIn Content",  sort_order: 10 },
  { id: "ai",                label: "AI",                sort_order: 20 },
  { id: "automation",        label: "Automation",        sort_order: 30 },
  { id: "outreach",          label: "Outreach",          sort_order: 40 },
  { id: "gtm",               label: "GTM",               sort_order: 50 },
  { id: "ads",               label: "Ads",               sort_order: 60 },
  { id: "seo",               label: "SEO",               sort_order: 70 },
  { id: "agency-operations", label: "Agency Operations", sort_order: 80 },
  { id: "investor",          label: "Investor",          sort_order: 90 },
];
console.log("\nStep 3 — upsert canonical 9 categories");
if (apply) {
  await fetch(`${SUPABASE_URL}/rest/v1/categories?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: SR,
      Authorization: `Bearer ${SR}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(CANONICAL),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`upsert categories → ${r.status} ${await r.text()}`);
  });
}
for (const c of CANONICAL) log(`${c.id}:`, c.label);

// ---------- Step 4: normalize accounts.niche ----------
const accounts = await sb(
  "GET",
  "accounts?select=id,name,niche,category_id&niche=not.is.null",
);
const nicheUpdates = [];
for (const a of accounts) {
  const n = normalize(a.niche);
  if (!n) continue;
  if (n.niche !== a.niche || n.category_id !== a.category_id) {
    nicheUpdates.push({ id: a.id, name: a.name, before_niche: a.niche, before_cat: a.category_id, after_niche: n.niche, after_cat: n.category_id });
  }
}
console.log("\nStep 4 — normalize accounts.niche + backfill category_id");
log("accounts with non-canonical niche:", nicheUpdates.length);
const nicheCounts = new Map();
for (const u of nicheUpdates) {
  const k = `${u.before_niche} → ${u.after_niche}`;
  nicheCounts.set(k, (nicheCounts.get(k) ?? 0) + 1);
}
for (const [k, c] of [...nicheCounts.entries()].sort((a, b) => b[1] - a[1])) {
  log("  " + k, c);
}
if (apply) {
  for (const u of nicheUpdates) {
    await sb("PATCH", `accounts?id=eq.${u.id}`, { niche: u.after_niche, category_id: u.after_cat });
  }
}

// ---------- Step 5: backfill category_id for any matching-niche rows still missing it ----------
const nullCat = await sb(
  "GET",
  "accounts?select=id,name,niche&category_id=is.null&niche=not.is.null",
);
const catBackfill = [];
for (const a of nullCat) {
  const n = normalize(a.niche);
  if (n) catBackfill.push({ id: a.id, name: a.name, category_id: n.category_id, niche: n.niche });
}
console.log("\nStep 5 — backfill category_id for matching niches");
log("rows to backfill:", catBackfill.length);
if (apply) {
  for (const a of catBackfill) {
    await sb("PATCH", `accounts?id=eq.${a.id}`, { category_id: a.category_id, niche: a.niche });
  }
}

// ---------- Step 5b: re-sync niche to category label for any straggler ----------
// Catches cases like Robbie Ferguson — has category_id='gtm' (set by
// migration-012's explicit override) but niche='GAMES' that the regex rules
// never matched. After this step, accounts.niche always equals the canonical
// label of accounts.category_id.
const CAT_LABEL = Object.fromEntries(CANONICAL.map((c) => [c.id, c.label]));
const all = await sb("GET", "accounts?select=id,name,niche,category_id");
const labelFixes = [];
for (const a of all) {
  if (!a.category_id) continue;
  const want = CAT_LABEL[a.category_id];
  if (!want) continue; // ghost category — already handled
  if (a.niche !== want) labelFixes.push({ id: a.id, name: a.name, before: a.niche, after: want });
}
console.log("\nStep 5b — sync niche label to category label");
log("rows to fix:", labelFixes.length);
for (const f of labelFixes.slice(0, 10)) {
  log(`  ${f.name}:`, `"${f.before}" → "${f.after}"`);
}
if (labelFixes.length > 10) log(`  ... and ${labelFixes.length - 10} more`, "");
if (apply) {
  for (const f of labelFixes) {
    await sb("PATCH", `accounts?id=eq.${f.id}`, { niche: f.after });
  }
}

// ---------- Step 6: wipe workspace_accounts.niche overrides ----------
const wsNiches = await sb(
  "GET",
  "workspace_accounts?select=workspace_id,account_id,niche&niche=not.is.null",
);
console.log("\nStep 6 — wipe workspace_accounts.niche overrides");
log("rows to clear:", wsNiches.length);
if (apply && wsNiches.length > 0) {
  await sb("PATCH", "workspace_accounts?niche=not.is.null", { niche: null });
}

// ---------- Final report ----------
console.log("\n" + "=".repeat(60));
if (!apply) {
  console.log("\nDRY RUN — re-run with --apply to write changes.\n");
  process.exit(0);
}

const after = await sb("GET", "accounts?select=category_id");
const catCount = new Map();
let nullCount = 0;
for (const a of after) {
  if (!a.category_id) nullCount++;
  else catCount.set(a.category_id, (catCount.get(a.category_id) ?? 0) + 1);
}
const cats = await sb("GET", "categories?select=id,label&order=sort_order");
console.log(`\nFinal state — ${after.length} accounts, ${cats.length} categories\n`);
for (const c of cats) log(`${c.label}:`, catCount.get(c.id) ?? 0);
if (nullCount > 0) log("(uncategorized):", nullCount);
console.log("\nDone.\n");
