export function stripArtifactFences(text: string): string {
  return text
    .replace(/```(?:post|hook|cite)\s*\n[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
