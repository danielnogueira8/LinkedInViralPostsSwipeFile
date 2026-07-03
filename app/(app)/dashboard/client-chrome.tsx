"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";

const DashboardToaster = dynamic(
  () => import("@/components/ui/sonner").then((mod) => mod.Toaster),
  { ssr: false },
);

type CommandPaletteComponent = ComponentType<{ defaultOpen?: boolean }>;

function CommandPaletteLoader() {
  const [Palette, setPalette] = useState<CommandPaletteComponent | null>(null);
  const [openOnMount, setOpenOnMount] = useState(false);

  useEffect(() => {
    if (Palette) return;

    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setOpenOnMount(true);
      void import("@/components/command-palette").then((mod) => {
        setPalette(() => mod.CommandPalette);
      });
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [Palette]);

  return Palette ? <Palette defaultOpen={openOnMount} /> : null;
}

export function DashboardClientChrome() {
  return (
    <>
      <CommandPaletteLoader />
      <DashboardToaster closeButton position="top-right" />
    </>
  );
}
