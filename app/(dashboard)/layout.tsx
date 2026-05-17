import { Toaster } from "@/components/ui/sonner";
import { SideNav } from "./nav";
import { Flame } from "lucide-react";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="w-60 shrink-0 border-r border-border/60 bg-sidebar flex flex-col">
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-border/60">
          <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground grid place-items-center shadow-sm">
            <Flame className="h-4 w-4" />
          </div>
          <div>
            <div className="font-semibold text-sm leading-tight">Swipe File</div>
            <div className="text-[10px] text-muted-foreground leading-tight">LinkedIn intel</div>
          </div>
        </div>
        <div className="p-3 flex-1">
          <SideNav />
        </div>
        <div className="p-3 border-t border-border/60 text-xs text-muted-foreground">Internal · v0.1</div>
      </aside>
      <main className="flex-1 min-w-0">
        <div className="max-w-6xl mx-auto p-8">{children}</div>
      </main>
      <Toaster richColors closeButton position="top-right" />
    </div>
  );
}
