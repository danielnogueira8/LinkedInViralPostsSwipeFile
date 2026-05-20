import { scopedSupabase } from "@/lib/supabase-scoped";
import { ClientsManager } from "./manager";

// Dropped `force-dynamic` — auth() already makes this dynamic, and the
// Router Cache makes back-nav feel instant.

export default async function ClientsPage() {
  const sb = await scopedSupabase();
  const { data: clients } = await sb
    .clientsSelect("*")
    .order("created_at", { ascending: false });
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
