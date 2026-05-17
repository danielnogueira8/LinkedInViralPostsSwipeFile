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
