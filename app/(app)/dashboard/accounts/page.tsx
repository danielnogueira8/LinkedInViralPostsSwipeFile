import { scopedSupabase } from "@/lib/supabase-scoped";
import { ScrapePanel } from "./scrape-panel";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ArrowDown, ArrowUp, ExternalLink } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { AddAccountButton, DeleteAccountButton } from "./account-actions";

export const dynamic = "force-dynamic";

type SortKey = "name" | "niche";
type SortDir = "asc" | "desc";
type SP = { sort?: string; dir?: string };

type AccountRow = {
  id: string;
  name: string;
  profile_url: string;
  linkedin_handle: string;
  niche: string | null;
  source: string;
  synced_at: string | null;
};

export default async function AccountsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const sort: SortKey = sp.sort === "niche" ? "niche" : "name";
  const dir: SortDir = sp.dir === "desc" ? "desc" : "asc";
  const sb = await scopedSupabase();

  // Pull tracked accounts via the workspace_accounts join. Niche may be
  // overridden per-workspace; fall back to the global accounts.niche.
  const { data: tracked } = await sb
    .workspaceAccountsSelect(
      "niche, accounts!inner(id, name, profile_url, linkedin_handle, niche, source, synced_at)",
    )
    .order("added_at", { ascending: false });

  const accountsRaw: AccountRow[] = ((tracked ?? []) as unknown as Array<{
    niche: string | null;
    accounts: AccountRow | AccountRow[];
  }>).map((row) => {
    const acc = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
    return { ...acc, niche: row.niche ?? acc.niche };
  });

  const accounts = [...accountsRaw].sort((a, b) => {
    const av = (a[sort] ?? "").toLocaleLowerCase();
    const bv = (b[sort] ?? "").toLocaleLowerCase();
    if (!av && bv) return 1;
    if (av && !bv) return -1;
    if (av === bv) return a.name.localeCompare(b.name);
    const cmp = av.localeCompare(bv);
    return dir === "asc" ? cmp : -cmp;
  });
  const lastSyncedAt = accounts.reduce<string | null>((acc, a) => {
    if (!a.synced_at) return acc;
    return !acc || a.synced_at > acc ? a.synced_at : acc;
  }, null);
  const knownNiches = Array.from(
    new Set(accounts.map((a) => a.niche).filter((n): n is string => !!n)),
  ).sort();
  const manualCount = accounts.filter((a) => a.source === "manual").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display tracking-tight">
            Accounts
            <span className="ml-3 align-middle text-base font-sans font-medium text-muted-foreground tabular-nums">
              {accounts.length}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Tracking <span className="font-medium text-foreground tabular-nums">{accounts.length}</span> {accounts.length === 1 ? "account" : "accounts"}, synced from your Google Sheet
            {manualCount > 0 && (
              <>
                <span className="mx-1.5 text-border">·</span>
                <span className="font-medium text-foreground tabular-nums">{manualCount}</span> added manually
              </>
            )}.
          </p>
        </div>
        <AddAccountButton knownNiches={knownNiches} />
      </div>

      <ScrapePanel accountsTotal={accounts.length} lastSyncedAt={lastSyncedAt} />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead><SortableHeader label="Name" column="name" sort={sort} dir={dir} /></TableHead>
              <TableHead>Handle</TableHead>
              <TableHead><SortableHeader label="Niche" column="niche" sort={sort} dir={dir} /></TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Last synced</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  <a href={a.profile_url} target="_blank" className="inline-flex items-center gap-1 hover:text-foreground">
                    {a.linkedin_handle} <ExternalLink className="h-3 w-3" />
                  </a>
                </TableCell>
                <TableCell>{a.niche ? <Badge variant="secondary">{a.niche}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell>
                  {a.source === "manual" ? (
                    <Badge variant="outline" className="text-[10px] font-normal">Manual</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">Sheet</span>
                  )}
                </TableCell>
                <TableCell
                  className="text-right text-muted-foreground text-xs tabular-nums"
                  title={a.synced_at ? new Date(a.synced_at).toLocaleString() : ""}
                >
                  {a.synced_at ? formatSyncedAt(a.synced_at) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {a.source === "manual" && <DeleteAccountButton id={a.id} name={a.name} />}
                </TableCell>
              </TableRow>
            ))}
            {accounts.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No accounts. Click &quot;Sync sheet&quot; above or use &quot;Add account&quot;.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function SortableHeader({
  label,
  column,
  sort,
  dir,
}: {
  label: string;
  column: SortKey;
  sort: SortKey;
  dir: SortDir;
}) {
  const active = sort === column;
  const nextDir: SortDir = active && dir === "asc" ? "desc" : "asc";
  const href = `/accounts?sort=${column}&dir=${nextDir}`;
  const Icon = active ? (dir === "asc" ? ArrowUp : ArrowDown) : null;
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1 hover:text-foreground transition-colors",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {label}
      {Icon && <Icon className="h-3 w-3" />}
    </Link>
  );
}

function formatSyncedAt(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}
