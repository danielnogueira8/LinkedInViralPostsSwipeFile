import { wrapUntrustedDelimited } from "@/lib/agent/untrusted";
import type { StructureMatchResult } from "@/lib/structure-match";
import type { StructureContentType } from "@/lib/templates";

export type OriginalTemplateReference = {
  title: string;
  structureType: StructureContentType;
  body: string;
};

export function originalTemplateMatch(
  match: StructureMatchResult | null | undefined,
): StructureMatchResult | null {
  if (!match) return null;
  const considered = match.considered.filter(
    (item) => item.kind === "template" || item.kind === "builtin",
  );
  const candidate = considered[0];
  return candidate ? { candidate, considered } : null;
}

export function originalTemplateReferenceFromMatch(
  match: StructureMatchResult | null | undefined,
): OriginalTemplateReference | null {
  const candidate = originalTemplateMatch(match)?.candidate;
  if (!candidate?.text.trim()) return null;

  return {
    title: candidate.title,
    structureType: candidate.structureType,
    body: candidate.text,
  };
}

export function renderOriginalTemplateReference(
  reference: OriginalTemplateReference | null | undefined,
): string {
  if (!reference?.body.trim()) return "";

  return [
    "CONTENT TEMPLATE REFERENCE DATA",
    `Structural arc: ${reference.structureType}`,
    "Use this Content Template as a quality and structure reference only. Study its hook mechanics, progression, paragraph rhythm, and ending shape.",
    "Do not fill it line by line, copy its wording, or inherit facts, claims, anecdotes, numbers, calls to action, or placeholders. Build an original post around the user's own thesis, evidence, and voice. If the template needs a fact the supplied context does not contain, write around that move instead of inventing it.",
    wrapUntrustedDelimited({
      label: "CONTENT TEMPLATE",
      endLabel: "END CONTENT TEMPLATE",
      text: `Template title: ${reference.title}\n\n${reference.body}`,
    }),
  ].join("\n\n");
}
