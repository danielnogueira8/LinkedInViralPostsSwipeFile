export function isCurrentVoicePoll(
  requestId: number,
  currentRequestId: number,
): boolean {
  return requestId === currentRequestId;
}
