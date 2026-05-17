import { Toaster } from "@/components/ui/sonner";
import { SideNav } from "./nav";
import { Flame } from "lucide-react";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full bg-muted/30">
      <aside className="w-60 shrink-0 border-r bg-background flex flex-col">
        <div className="h-14 flex items-center gap-2 px-4 border-b">
          <div className="h-7 w-7 rounded-md bg-primary text-primary-foreground grid place-items-center">
            <Flame className="h-4 w-4" />
          </div>
          <div className="font-semibold text-sm">Swipe File</div>
        </div>
        <div className="p-3 flex-1">
          <SideNav />
        </div>
        <div className="p-3 border-t text-xs text-muted-foreground">Internal · v0.1</div>
      </aside>
      <main className="flex-1 min-w-0">
        <div className="max-w-6xl mx-auto p-8">{children}</div>
      </main>
      <Toaster richColors closeButton position="top-right" />
    </div>
  );
}
