export type SheetRow = {
  name: string;
  profile_url: string;
  niche: string | null;
  linkedin_handle: string;
};

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); row = []; cell = ""; }
        if (c === "\r" && csv[i + 1] === "\n") i++;
      } else cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

export function handleFromUrl(url: string): string {
  const m = url.match(/linkedin\.com\/in\/([^\/\?#]+)/i);
  return m ? m[1].toLowerCase() : url.toLowerCase();
}

/**
 * Canonical taxonomy (9 categories). Kept in sync with the `categories` table
 * (migration-015) and the RULES in scripts/normalize-niches.mjs. The sheet
 * column is free-form text typed by humans, so we normalize on ingest to
 * prevent drift from leaking back into the DB.
 *
 * Rules are evaluated top-to-bottom; first match wins. A non-matching niche
 * returns null for both fields (account lands uncategorized rather than under
 * a garbage label) — fix in the sheet or via the manual flow.
 */
const NICHE_RULES: Array<{ match: RegExp; niche: string; category_id: string }> = [
  // AI family
  { match: /^ai\b/i,                    niche: "AI", category_id: "ai" },
  { match: /^no-?code$/i,               niche: "AI", category_id: "ai" },
  { match: /^video\s*\/?\s*ai$/i,       niche: "AI", category_id: "ai" },

  // Ads family
  { match: /^ads(\s*\+\s*ugc)?$/i,      niche: "Ads", category_id: "ads" },
  { match: /^(paid|google|meta)\s+ads$/i, niche: "Ads", category_id: "ads" },

  // Outreach family
  { match: /^cold\s+email(\s*\/?\s*(ai|gtm))?$/i, niche: "Outreach", category_id: "outreach" },
  { match: /^linkedin\s*\/?\s*cold\s+email$/i,    niche: "Outreach", category_id: "outreach" },
  { match: /^(linkedin\s+)?outreach$/i,           niche: "Outreach", category_id: "outreach" },
  { match: /^sms$/i,                              niche: "Outreach", category_id: "outreach" },
  { match: /^lead\s+gen$/i,                       niche: "Outreach", category_id: "outreach" },

  // LinkedIn Content (absorbs old "LinkedIn" + personal brand + ghostwriting)
  { match: /^linkedin$/i,                  niche: "LinkedIn Content", category_id: "linkedin-content" },
  { match: /^linkedin\s+content$/i,        niche: "LinkedIn Content", category_id: "linkedin-content" },
  { match: /^agencies?\s*&\s*linkedin$/i,  niche: "LinkedIn Content", category_id: "linkedin-content" },
  { match: /^personal\s+brand$/i,          niche: "LinkedIn Content", category_id: "linkedin-content" },
  { match: /^ghostwriting$/i,              niche: "LinkedIn Content", category_id: "linkedin-content" },

  // Automation
  { match: /^automation$/i,                niche: "Automation", category_id: "automation" },

  // GTM / Marketing
  { match: /^gtm$/i,                       niche: "GTM", category_id: "gtm" },
  { match: /^marketing$/i,                 niche: "GTM", category_id: "gtm" },
  { match: /^email\s+marketing$/i,         niche: "GTM", category_id: "gtm" },

  // SEO / Agency Operations / Investor (canonical labels, but force-fix case)
  { match: /^seo$/i,                       niche: "SEO", category_id: "seo" },
  { match: /^agency\s+operations$/i,       niche: "Agency Operations", category_id: "agency-operations" },
  { match: /^investor$/i,                  niche: "Investor", category_id: "investor" },
];

export function normalizeSheetNiche(
  raw: string | null,
): { niche: string | null; category_id: string | null } {
  if (!raw) return { niche: null, category_id: null };
  const trimmed = raw.trim();
  if (!trimmed) return { niche: null, category_id: null };
  for (const r of NICHE_RULES) {
    if (r.match.test(trimmed)) return { niche: r.niche, category_id: r.category_id };
  }
  // Unknown free-form niche — keep the raw label for visibility but don't
  // attach a category. Fix the sheet or re-categorize via the manual flow.
  return { niche: trimmed, category_id: null };
}

/**
 * Pull sheet rows and upsert into accounts. Returns the number of unique rows synced.
 * Shared by the manual "Sync sheet" button, the daily cron, and the pre-scrape auto-sync.
 *
 * Never overwrites accounts marked source='manual': those rows are owned by the
 * user, not the sheet. If a manual row's URL later appears in the sheet, the
 * sheet entry is skipped (the manual row wins).
 *
 * A blank niche cell in the sheet does NOT overwrite an existing DB niche —
 * the sheet only sets niche when it has a value. This prevents accidental
 * wipes when the sheet's niche column is blank, shifted, or missing.
 */
export async function syncAccountsFromSheet(): Promise<{ count: number; skipped: number; at: string }> {
  const { supabaseAdmin } = await import("./supabase");
  const rows = await fetchSheetAccounts();
  const sb = supabaseAdmin();

  const { data: manualRows } = await sb
    .from("accounts")
    .select("profile_url")
    .eq("source", "manual");
  const manualUrls = new Set((manualRows ?? []).map((r) => r.profile_url.toLowerCase()));

  const seen = new Set<string>();
  const at = new Date().toISOString();
  let skipped = 0;
  const filtered = rows.filter((r) => {
    const key = r.profile_url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    if (manualUrls.has(key)) { skipped++; return false; }
    return true;
  });

  // Normalize each row's niche into the canonical taxonomy + derive
  // category_id. Sheet rows with a blank niche cell still skip the niche
  // write (legacy behavior — prevents accidental wipes), but rows with a
  // matching niche also get their category_id backfilled.
  const normalized = filtered.map((r) => ({
    row: r,
    ...normalizeSheetNiche(r.niche),
  }));

  // Normalize profile_url to lowercase on insert so it matches the case
  // used by both the dedupe set above and the manual-account path. Without
  // this, two sheet rows differing only in case would both insert (on a
  // case-sensitive unique index) or churn synced_at against the wrong
  // canonical row (on case-insensitive).
  const withNiche = normalized
    .filter((n) => n.niche !== null)
    .map((n) => ({
      name: n.row.name,
      profile_url: n.row.profile_url.toLowerCase(),
      linkedin_handle: n.row.linkedin_handle,
      niche: n.niche,
      category_id: n.category_id,
      source: "sheet",
      synced_at: at,
    }));
  const withoutNiche = normalized
    .filter((n) => n.niche === null)
    .map((n) => ({
      name: n.row.name,
      profile_url: n.row.profile_url.toLowerCase(),
      linkedin_handle: n.row.linkedin_handle,
      source: "sheet",
      synced_at: at,
    }));

  if (withNiche.length > 0) {
    const { error } = await sb.from("accounts").upsert(withNiche, { onConflict: "profile_url" });
    if (error) throw error;
  }
  if (withoutNiche.length > 0) {
    const { error } = await sb.from("accounts").upsert(withoutNiche, { onConflict: "profile_url" });
    if (error) throw error;
  }
  return { count: filtered.length, skipped, at };
}

/**
 * Returns the most recent accounts.synced_at as an ISO string, or null if no accounts exist.
 */
export async function latestAccountsSyncAt(): Promise<string | null> {
  const { supabaseAdmin } = await import("./supabase");
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("accounts")
    .select("synced_at")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.synced_at ?? null;
}

export async function fetchSheetAccounts(): Promise<SheetRow[]> {
  const url = process.env.SHEET_CSV_URL;
  if (!url) throw new Error("SHEET_CSV_URL not set");
  const res = await fetch(url, { redirect: "follow", cache: "no-store" });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const csv = await res.text();
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toUpperCase());
  const nameIdx = header.indexOf("NAME");
  const urlIdx = header.indexOf("PROFILE LINK");
  const nicheIdx = header.indexOf("NICHE");
  if (nameIdx < 0 || urlIdx < 0) throw new Error("Sheet missing NAME or PROFILE LINK column");

  const out: SheetRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[nameIdx] || "").trim();
    const profile_url = (r[urlIdx] || "").trim();
    if (!name || !profile_url) continue;
    out.push({
      name,
      profile_url,
      niche: nicheIdx >= 0 ? (r[nicheIdx] || "").trim() || null : null,
      linkedin_handle: handleFromUrl(profile_url),
    });
  }
  return out;
}
