// Browser paste events already expose clipboard files; using that event data
// avoids a clipboard-read permission prompt and keeps handling scoped to the
// focused editor. This deliberately returns every image MIME type here — the
// shared post-media validation layer is the single authority on what we accept.
type ClipboardFileItem = {
  kind: string;
  type: string;
  getAsFile: () => File | null;
};

type ClipboardDataLike = {
  files?: ArrayLike<File>;
  items?: ArrayLike<ClipboardFileItem>;
  types?: ArrayLike<string>;
};

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

function normalizedClipboardImage(file: File, itemType: string): File {
  const type = (file.type || itemType).toLowerCase();
  if (file.name.trim() && file.type) return file;
  const extension = EXTENSIONS[type] ?? "png";
  return new File([file], file.name.trim() || `clipboard-image.${extension}`, {
    type,
    lastModified: file.lastModified || Date.now(),
  });
}

function fileKey(file: File): string {
  return `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
}

// Read image files from a single paste event. `items` is necessary for many
// screenshot/browser clipboard implementations; `files` is retained as a
// browser fallback. The event-local fingerprint de-dupes an item surfaced by
// both collections without blocking a later, intentional paste.
export function clipboardImageFiles(data: ClipboardDataLike): File[] {
  const candidates: Array<{ file: File; type: string }> = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.toLowerCase().startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) candidates.push({ file, type: item.type });
  }
  if (candidates.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.toLowerCase().startsWith("image/")) {
        candidates.push({ file, type: file.type });
      }
    }
  }

  const seen = new Set<string>();
  return candidates
    .map(({ file, type }) => normalizedClipboardImage(file, type))
    .filter((file) => {
      const key = fileKey(file);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Leave the browser's normal text insertion alone when an image and text are
// copied together. A textarea cannot insert the image itself, but it can still
// insert the accompanying text while the upload starts.
export function clipboardHasText(data: ClipboardDataLike): boolean {
  const types = [
    ...Array.from(data.types ?? []),
    ...Array.from(data.items ?? [])
      .filter((item) => item.kind === "string")
      .map((item) => item.type),
  ];
  return types.some((type) => ["text/plain", "text/html"].includes(type.toLowerCase()));
}
