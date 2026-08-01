export function isCurrentKnowledgeRequest(
  requestId: number,
  currentRequestId: number,
): boolean {
  return requestId === currentRequestId;
}
