import { supabaseAdmin } from "@/lib/supabase";
import { ClientsManager } from "./manager";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const sb = supabaseAdmin();
  const { data: clients } = await sb.from("clients").select("*").order("created_at", { ascending: false });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-display tracking-tight">Clients</h1>
        <p className="text-sm text-muted-foreground mt-1">Brand palettes used for recoloring viral graphics.</p>
      </div>
      <ClientsManager initial={clients ?? []} />
    </div>
  );
}
