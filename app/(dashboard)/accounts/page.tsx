import { supabaseAdmin } from "@/lib/supabase";
import { ScrapePanel } from "./scrape-panel";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const sb = supabaseAdmin();
  const { data: accounts } = await sb.from("accounts").select("*").order("name");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Accounts</h1>
        <p className="text-sm text-muted-foreground mt-1">Sources synced from your Google Sheet.</p>
      </div>

      <ScrapePanel accountsTotal={accounts?.length ?? 0} />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Handle</TableHead>
              <TableHead>Niche</TableHead>
              <TableHead className="text-right">Last synced</TableHead>
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
                <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
                  {new Date(a.synced_at).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
            {(!accounts || accounts.length === 0) && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No accounts. Click &quot;Sync sheet&quot; above.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
