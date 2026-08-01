import { estimateTokens, type ChatMessage } from "@/lib/openrouter";

export type PromptCostSection = {
  text_chars: number;
  estimated_tokens: number;
};

export type WriterPromptCostProfile = {
  version: 1;
  total_text_chars: number;
  estimated_input_tokens: number;
  cacheable_system_prefix_chars: number;
  sections: Record<string, PromptCostSection>;
};

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function totalMessageText(messages: ChatMessage[]): string {
  return messages.map(messageText).join("");
}

export function measureWriterPromptCost(input: {
  messages: ChatMessage[];
  cacheableSystemPrefixChars?: number;
  sections: Record<string, string>;
}): WriterPromptCostProfile {
  const totalText = totalMessageText(input.messages);
  const sections = Object.fromEntries(
    Object.entries(input.sections)
      .filter(([, text]) => text.length > 0)
      .map(([name, text]) => [
        name,
        {
          text_chars: text.length,
          estimated_tokens: estimateTokens(text),
        },
      ]),
  );

  return {
    version: 1,
    total_text_chars: totalText.length,
    estimated_input_tokens: estimateTokens(totalText),
    cacheable_system_prefix_chars: Math.min(
      totalText.length,
      Math.max(0, input.cacheableSystemPrefixChars ?? 0),
    ),
    sections,
  };
}

export function remeasureWriterPromptCost(
  profile: WriterPromptCostProfile,
  messages: ChatMessage[],
): WriterPromptCostProfile {
  const totalText = totalMessageText(messages);
  const retryChars = Math.max(0, totalText.length - profile.total_text_chars);
  return {
    ...profile,
    total_text_chars: totalText.length,
    estimated_input_tokens: estimateTokens(totalText),
    ...(retryChars > 0
      ? {
          sections: {
            ...profile.sections,
            retry_context: {
              text_chars: retryChars,
              estimated_tokens: estimateTokens("x".repeat(retryChars)),
            },
          },
        }
      : {}),
  };
}
