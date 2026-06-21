"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { SideNav } from "./nav";

// Desktop sidebar (lg+). Collapsed to an icon rail by default; hovering expands
// it to full width as an OVERLAY (floats over content — no reflow). A pin button
// locks it fully open; the pin preference persists in localStorage per device.
//
// Mobile uses the separate bottom MobileNav, so this whole component is lg-only.

const PIN_KEY = "swipein:sidebar-pinned";
const RAIL_W = "5rem"; // collapsed icon rail (w-20)
const FULL_W = "15rem"; // expanded panel (w-60)

export function Sidebar({ badges }: { badges?: Record<string, number> }) {
  const [hovered, setHovered] = useState(false);
  // Persisted pin state. null = "not read yet" (server render + first client
  // paint), so SSR and hydration both show the collapsed default and there's no
  // mismatch. After mount we read localStorage once into a single state update.
  const [pinned, setPinned] = useState<boolean | null>(null);

  useEffect(() => {
    let stored = false;
    try {
      stored = localStorage.getItem(PIN_KEY) === "1";
    } catch {
      // localStorage blocked (private mode etc.) — stay with the default.
    }
    // Seeding state from an external system (localStorage) on mount is the
    // intended pattern; localStorage isn't available at render/SSR time.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read persisted pin on mount
    setPinned(stored);
  }, []);

  const togglePin = () => {
    setPinned((p) => {
      const next = !p;
      try {
        localStorage.setItem(PIN_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Effective pin: false until localStorage is read (pinned === null).
  const isPinned = pinned === true;
  // Expanded when pinned, or when hovered (only after mount, i.e. pinned read).
  const expanded = isPinned || (pinned !== null && hovered);

  return (
    // The rail always occupies RAIL_W in the layout flow; the inner panel grows
    // to FULL_W and floats above the page when expanded (absolute), so content
    // never shifts. When pinned, the rail itself takes FULL_W so the page makes
    // room (no overlay over content while pinned).
    <div
      className="hidden lg:block shrink-0 sticky top-0 h-screen transition-[width] duration-200 ease-out"
      style={{ width: isPinned ? FULL_W : RAIL_W }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <aside
        className={cn(
          "absolute inset-y-0 left-0 flex flex-col bg-sidebar border-r border-border/60 h-screen transition-[width] duration-200 ease-out",
          expanded && !isPinned && "shadow-xl z-40",
        )}
        style={{ width: expanded ? FULL_W : RAIL_W }}
      >
        {/* Header: logo + pin toggle */}
        <div className="h-20 flex items-center gap-2.5 px-4 shrink-0">
          <Image
            src="/swipeInIcon.png"
            alt="SwipeIn"
            width={48}
            height={48}
            priority
            className="h-12 w-12 rounded-lg shrink-0"
          />
          {expanded && (
            <button
              type="button"
              onClick={togglePin}
              aria-label={isPinned ? "Unpin sidebar" : "Pin sidebar open"}
              title={isPinned ? "Unpin sidebar" : "Pin sidebar open"}
              className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
            >
              {isPinned ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeftOpen className="h-4 w-4" />
              )}
            </button>
          )}
        </div>

        <div className="px-3 pt-1 flex-1 overflow-y-auto overflow-x-hidden">
          <SideNav badges={badges} collapsed={!expanded} />
        </div>

        <div className="px-3 py-3 border-t border-border/60">
          <UserButton
            showName={expanded}
            appearance={{
              elements: {
                userButtonTrigger: cn(
                  "w-full rounded-lg hover:bg-accent/60 text-sm focus:shadow-none",
                  expanded ? "px-3 py-2" : "px-1.5 py-2 justify-center",
                ),
                userButtonBox: expanded
                  ? "flex-row-reverse w-full justify-end gap-2"
                  : "justify-center",
                userButtonOuterIdentifier: "text-sm",
              },
            }}
          />
        </div>
      </aside>
    </div>
  );
}
