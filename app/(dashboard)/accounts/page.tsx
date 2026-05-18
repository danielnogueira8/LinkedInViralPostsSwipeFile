import { supabaseAdmin } from "@/lib/supabase";
import { ScrapePanel } from "./scrape-panel";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { AddAccountButton, DeleteAccountButton } from "./account-actions";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const sb = supabaseAdmin();
  const { data: accounts } = await sb.from("accounts").select("*").order("name");
  const lastSyncedAt = (accounts ?? []).reduce<string | null>((acc, a) => {
    if (!a.synced_at) return acc;
    return !acc || a.synced_at > acc ? a.synced_at : acc;
  }, null);
  const knownNiches = Array.from(
    new Set((accounts ?? []).map((a) => a.niche).filter((n): n is string => !!n)),
  ).sort();
  const manualCount = (accounts ?? []).filter((a) => a.source === "manual").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Synced from your Google Sheet
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

      <ScrapePanel accountsTotal={accounts?.length ?? 0} lastSyncedAt={lastSyncedAt} />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Handle</TableHead>
              <TableHead>Niche</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Last synced</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts?.map((a) => (
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
            {(!accounts || accounts.length === 0) && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No accounts. Click &quot;Sync sheet&quot; above or use &quot;Add account&quot;.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function formatSyncedAt(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}
