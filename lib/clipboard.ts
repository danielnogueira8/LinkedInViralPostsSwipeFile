import { toast } from "sonner";

// Copy text to the clipboard with consistent success/failure UX.
//
// navigator.clipboard.writeText rejects in several real situations the bare
// call sites were silently dropping: a non-secure (http) context, denied
// clipboard permission, the document not being focused, or the API being
// absent entirely (older/embedded webviews). An unhandled rejection there
// leaves the user with no feedback — the success toast never fires and nothing
// explains why. This helper resolves to a boolean instead of throwing: it
// fires the success toast on a real copy and a "copy it manually" error toast
// otherwise, so every caller gets uniform behaviour and can gate UI (e.g. a
// transient "Copied" checkmark) on the actual result.
export async function copyToClipboard(
  text: string,
  successMessage = "Copied",
): Promise<boolean> {
  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard?.writeText
    ) {
      throw new Error("Clipboard API unavailable");
    }
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
    return true;
  } catch {
    toast.error("Couldn't copy — copy it manually");
    return false;
  }
}
