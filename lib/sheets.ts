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

  const withNiche = filtered
    .filter((r) => r.niche !== null)
    .map((r) => ({
      name: r.name,
      profile_url: r.profile_url,
      linkedin_handle: r.linkedin_handle,
      niche: r.niche,
      source: "sheet",
      synced_at: at,
    }));
  const withoutNiche = filtered
    .filter((r) => r.niche === null)
    .map((r) => ({
      name: r.name,
      profile_url: r.profile_url,
      linkedin_handle: r.linkedin_handle,
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
