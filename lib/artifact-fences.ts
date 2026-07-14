export function stripArtifactFences(text: string): string {
  return text
    .replace(/```(?:post|hook|cite)\s*\n[\s\S]*?```/gi, "")
    // Persistence must fail closed when a provider stops after opening an
    // artifact fence. The incomplete suffix is a candidate, not chat prose.
    .replace(/```(?:post|hook|cite)\b[^\n]*\n[\s\S]*$/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
