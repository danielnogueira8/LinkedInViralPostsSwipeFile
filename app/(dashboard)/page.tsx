import { supabaseAdmin } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Inbox, Flame, FileText, ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const sb = supabaseAdmin();
  const [{ count: accountsCount }, { count: postsCount }, { count: viralCount }, { count: templatesCount }, { data: lastRun }] = await Promise.all([
    sb.from("accounts").select("*", { count: "exact", head: true }),
    sb.from("posts").select("*", { count: "exact", head: true }),
    sb.from("posts").select("*", { count: "exact", head: true }).eq("is_viral", true),
    sb.from("templates").select("*", { count: "exact", head: true }),
    sb.from("runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-4xl font-display tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Daily snapshot of your LinkedIn intel.</p>
        </div>
        <Link href="/accounts">
          <Button>Run scrape <ArrowRight className="h-4 w-4" /></Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Accounts tracked" value={accountsCount ?? 0} icon={<Users className="h-4 w-4" />} />
        <Stat label="Posts collected" value={postsCount ?? 0} icon={<Inbox className="h-4 w-4" />} />
        <Stat label="Viral posts" value={viralCount ?? 0} icon={<Flame className="h-4 w-4" />} accent />
        <Stat label="Templates" value={templatesCount ?? 0} icon={<FileText className="h-4 w-4" />} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Latest run</CardTitle>
          <CardDescription>Status of the most recent scrape</CardDescription>
        </CardHeader>
        <CardContent>
          {lastRun ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-3">
                <RunBadge status={lastRun.status} />
                <span className="text-muted-foreground">Started {new Date(lastRun.started_at).toLocaleString()}</span>
              </div>
              {lastRun.posts_count != null && (
                <div className="flex gap-6 pt-2 text-muted-foreground">
                  <span><strong className="text-foreground">{lastRun.posts_count}</strong> posts</span>
                  <span><strong className="text-foreground">{lastRun.viral_count ?? 0}</strong> viral</span>
                  <span><strong className="text-foreground">{lastRun.accounts_count}</strong> accounts</span>
                </div>
              )}
              {lastRun.error && (
                <div className="text-destructive text-xs mt-2 bg-destructive/10 rounded px-2 py-1.5">{lastRun.error}</div>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No runs yet. Head to <Link className="underline" href="/accounts">Accounts</Link> to kick off your first scrape.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, icon, accent }: { label: string; value: number; icon: React.ReactNode; accent?: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        <div className={accent ? "text-orange-500" : "text-muted-foreground"}>{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

function RunBadge({ status }: { status: string }) {
  const variant: "default" | "secondary" | "destructive" | "outline" =
    status === "ok" ? "default" : status === "error" ? "destructive" : "secondary";
  return <Badge variant={variant} className="capitalize">{status}</Badge>;
}
