"use client";

import { Search } from "lucide-react";

import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/ui-events";

function WorkspaceSearchButton() {
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))
      }
      className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      aria-label="Search the workspace"
      title="Search the workspace"
    >
      <Search className="size-4" aria-hidden="true" />
    </button>
  );
}

export { WorkspaceSearchButton };
