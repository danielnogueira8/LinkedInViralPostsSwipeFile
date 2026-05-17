import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Brain, Bot, DollarSign, Activity } from "lucide-react";
import { CostChart } from "./chart";

export const dynamic = "force-dynamic";

type CostsResponse = {
  today: Summary;
  last7: Summary;
  last30: Summary;
  daily: { day: string; anthropic: number; apify: number; total: number }[];
  kinds: { key: string; provider: string; kind: string; count: number; cost: number }[];
  recent: RecentEvent[];
};
type Summary = {
  total: number; anthropic: number; apify: number;
  anthropic_input_tokens: number; anthropic_output_tokens: number;
  apify_units: number; calls: number;
};
type RecentEvent = {
  ts: string; provider: string; kind: string; model: string | null;
  input_tokens: number | null; output_tokens: number | null;
  units: number | null; cost_usd: number;
};

async function getCosts(): Promise<CostsResponse> {
  const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  const res = await fetch(`${base}/api/costs`, { cache: "no-store" });
  return res.json();
}

export default async function CostsPage() {
  const data = await getCosts();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Costs</h1>
        <p className="text-sm text-muted-foreground mt-1">Anthropic and Apify spend tracked per call.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Today" value={data.today.total} icon={<DollarSign className="h-4 w-4" />} />
        <Stat label="Last 7 days" value={data.last7.total} icon={<Activity className="h-4 w-4" />} />
        <Stat label="Last 30 days" value={data.last30.total} icon={<Activity className="h-4 w-4" />} />
        <Stat label="API calls (30d)" raw={data.last30.calls.toLocaleString()} icon={<Activity className="h-4 w-4" />} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ProviderCard
          name="Anthropic"
          icon={<Brain className="h-4 w-4" />}
          cost30d={data.last30.anthropic}
          extra={
            <div className="space-y-1 text-xs text-muted-foreground tabular-nums">
              <div className="flex justify-between"><span>Input tokens (30d)</span><span className="text-foreground">{data.last30.anthropic_input_tokens.toLocaleString()}</span></div>
              <div className="flex justify-between"><span>Output tokens (30d)</span><span className="text-foreground">{data.last30.anthropic_output_tokens.toLocaleString()}</span></div>
            </div>
          }
        />
        <ProviderCard
          name="Apify"
          icon={<Bot className="h-4 w-4" />}
          cost30d={data.last30.apify}
          extra={
            <div className="space-y-1 text-xs text-muted-foreground tabular-nums">
              <div className="flex justify-between"><span>Posts scraped (30d)</span><span className="text-foreground">{Math.round(data.last30.apify_units).toLocaleString()}</span></div>
              <div className="flex justify-between"><span>Rate</span><span className="text-foreground/70">$5 / 1,000 posts</span></div>
            </div>
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily spend · last 30 days</CardTitle>
          <CardDescription>Stacked cost per day</CardDescription>
        </CardHeader>
        <CardContent>
          {data.daily.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">No usage yet.</div>
          ) : (
            <CostChart daily={data.daily} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By call type · last 30 days</CardTitle>
        </CardHeader>
        <CardContent>
          {data.kinds.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">No usage yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.kinds.map((k) => (
                  <TableRow key={k.key}>
                    <TableCell><Badge variant="outline" className="capitalize">{k.provider}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{k.kind}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.count.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{fmt(k.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent calls</CardTitle>
          <CardDescription>Last 50 API calls</CardDescription>
        </CardHeader>
        <CardContent>
          {data.recent.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">No calls logged yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Tokens / units</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recent.map((e, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-muted-foreground text-xs tabular-nums">{new Date(e.ts).toLocaleString()}</TableCell>
                    <TableCell><Badge variant="outline" className="capitalize">{e.provider}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{e.kind}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                      {e.provider === "anthropic"
                        ? `${(e.input_tokens ?? 0).toLocaleString()} in / ${(e.output_tokens ?? 0).toLocaleString()} out`
                        : `${e.units ?? 0} post${(e.units ?? 0) === 1 ? "" : "s"}`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(e.cost_usd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, raw, icon }: { label: string; value?: number; raw?: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {raw ?? fmt(value ?? 0)}
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderCard({ name, icon, cost30d, extra }: { name: string; icon: React.ReactNode; cost30d: number; extra: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">{icon}{name}</CardTitle>
          <Badge variant="secondary" className="tabular-nums">{fmt(cost30d)} <span className="ml-1 text-muted-foreground font-normal">/ 30d</span></Badge>
        </div>
      </CardHeader>
      <CardContent>{extra}</CardContent>
    </Card>
  );
}

function fmt(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
