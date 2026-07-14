export type PartialTextContract = {
  expectedCount?: number;
  requiredFields: string[];
  forbidFraming: boolean;
  fieldsOnly: boolean;
};

const COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function requestedExactCount(instruction: string): number | undefined {
  const match = instruction.match(
    /\bexactly\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  );
  if (!match) return undefined;
  const value = /^\d+$/.test(match[1])
    ? Number(match[1])
    : COUNT_WORDS[match[1].toLowerCase()];
  return Number.isInteger(value) && value > 0 && value <= 20
    ? value
    : undefined;
}

function requestedFields(instruction: string): string[] {
  const match = instruction.match(
    /\binclude\s+(?:only|exactly(?:\s+these\s+fields)?)\s*:\s*([^\n.]+)/i,
  );
  if (!match) return [];
  return match[1]
    .replace(/,?\s+(?:and|&)\s+/gi, ",")
    .split(",")
    .map((field) => field.trim().replace(/[:;]+$/, ""))
    .filter((field) => field.length > 0 && field.length <= 40)
    .slice(0, 8);
}

export function derivePartialTextContract(
  instruction: string,
): PartialTextContract | null {
  const expectedCount = requestedExactCount(instruction);
  const requiredFields = requestedFields(instruction);
  const forbidFraming =
    /\bno\s+(?:introduction|intro)(?:\s+or\s+conclusion)?\b|\bwithout\s+(?:an?\s+)?(?:introduction|intro|conclusion)\b/i.test(
      instruction,
    );
  const fieldsOnly =
    /\binclude\s+(?:only|exactly(?:\s+these\s+fields)?)\s*:/i.test(
      instruction,
    );
  if (!expectedCount && requiredFields.length === 0 && !forbidFraming) {
    return null;
  }
  return { expectedCount, requiredFields, forbidFraming, fieldsOnly };
}

function escapeRegex(value: string): string {
  return value
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("/", "\\s*\\/\\s*");
}

function fieldLinePattern(fields: string[]): RegExp {
  return new RegExp(
    `^(?:[-+*]\\s+)?(?:\\*\\*|__)?(?:${fields.map(escapeRegex).join("|")})(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?\\s*\\S`,
    "i",
  );
}

function requiredFieldPattern(field: string): RegExp {
  return new RegExp(
    `^(?:[-+*]\\s+)?(?:\\*\\*|__)?${escapeRegex(field)}(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?\\s*\\S`,
    "i",
  );
}

export function validatePartialTextOutput(
  output: string,
  contract: PartialTextContract | null,
): { ok: true } | { ok: false; error: string } {
  if (!contract) return { ok: true };

  const lines = output.trim().split(/\r?\n/);
  const items: Array<{ number: number; lines: string[] }> = [];
  const framing: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const marker = line.match(/^(\d{1,2})[.)](?:\s+(.*))?$/);
    if (marker) {
      items.push({
        number: Number(marker[1]),
        lines: marker[2]?.trim() ? [marker[2].trim()] : [],
      });
    } else if (items.length > 0) {
      items[items.length - 1].lines.push(line);
    } else {
      framing.push(line);
    }
  }

  if (
    contract.expectedCount !== undefined &&
    (items.length !== contract.expectedCount ||
      items.some((item, index) => item.number !== index + 1))
  ) {
    return {
      ok: false,
      error: `Return exactly ${contract.expectedCount} sequentially numbered items (1 through ${contract.expectedCount}).`,
    };
  }
  if (contract.forbidFraming && framing.length > 0) {
    return {
      ok: false,
      error: "Remove the introduction and start directly with item 1.",
    };
  }
  const trailingLine = items.at(-1)?.lines.at(-1) ?? "";
  if (
    contract.forbidFraming &&
    /^(?:conclusion\s*:|in\s+conclusion\b|overall\b|hope\s+this\s+helps\b|let\s+me\s+know\b|there\s+you\s+have\b|those\s+are\b)/i.test(
      trailingLine,
    )
  ) {
    return {
      ok: false,
      error: "Remove the conclusion and end with the final requested item.",
    };
  }

  if (contract.requiredFields.length > 0) {
    const allowedFieldLine = fieldLinePattern(contract.requiredFields);
    for (const item of items) {
      for (const field of contract.requiredFields) {
        const required = requiredFieldPattern(field);
        if (!item.lines.some((line) => required.test(line))) {
          return {
            ok: false,
            error: `Every numbered item must include a non-empty "${field}:" field.`,
          };
        }
      }
      if (
        contract.fieldsOnly &&
        item.lines.some((line) => !allowedFieldLine.test(line))
      ) {
        return {
          ok: false,
          error: `Each item may contain only these labeled fields: ${contract.requiredFields.join(", ")}. Put each field on its own line and remove all extra framing.`,
        };
      }
    }
  }

  return { ok: true };
}
