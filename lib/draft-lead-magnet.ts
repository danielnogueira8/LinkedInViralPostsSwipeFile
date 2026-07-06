export type DraftLeadMagnetContext = {
  title: string;
  selection: "manual" | "auto";
};

export function leadMagnetContextFromMeta(meta: unknown): DraftLeadMagnetContext | null {
  if (!meta || typeof meta !== "object") return null;
  const leadMagnet = (meta as { lead_magnet?: unknown }).lead_magnet;
  if (!leadMagnet || typeof leadMagnet !== "object") return null;
  const raw = leadMagnet as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  return {
    title,
    selection: raw.selection === "manual" ? "manual" : "auto",
  };
}
