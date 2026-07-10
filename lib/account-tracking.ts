export const MANUAL_ACCOUNT_LIMIT = 50;
export const MANUAL_ACCOUNT_LIMIT_MESSAGE =
  "You've reached the 50 manually-added creator limit.";

export function isManualAccountLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return (
    value.code === "P0001" &&
    typeof value.message === "string" &&
    value.message.startsWith("manual_account_limit:")
  );
}
