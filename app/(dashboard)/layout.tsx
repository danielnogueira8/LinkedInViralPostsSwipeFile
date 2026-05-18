import { Toaster } from "@/components/ui/sonner";
import { SideNav } from "./nav";
import { Flame } from "lucide-react";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="w-60 shrink-0 bg-background flex flex-col sticky top-0 h-screen">
        <div className="h-16 flex items-center gap-2.5 px-5">
          <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground grid place-items-center">
            <Flame className="h-4 w-4" />
          </div>
          <div>
            <div className="font-display text-lg leading-tight tracking-tight">Swipe File</div>
            <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">LinkedIn intel</div>
          </div>
        </div>
        <div className="px-3 pt-4 flex-1 overflow-y-auto">
          <SideNav />
        </div>
        <div className="px-5 py-4 text-[11px] text-muted-foreground flex items-center justify-between">
          <span>Internal</span>
          <span className="font-mono text-[10px]">v0.1</span>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <div className="max-w-[1400px] mx-auto px-6 sm:px-8 lg:px-10 py-8 lg:py-10">{children}</div>
      </main>
      <Toaster richColors closeButton position="top-right" />
    </div>
  );
}
