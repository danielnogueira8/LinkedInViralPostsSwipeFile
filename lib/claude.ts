import Anthropic from "@anthropic-ai/sdk";
import { logAnthropicUsage } from "./usage";

// Cheap model for bulk background tasks (templating, classification)
const FAST_MODEL = "claude-haiku-4-5-20251001";
// Smart model for the on-demand image-prompt task (rare, quality-sensitive)
const SMART_MODEL = "claude-sonnet-4-6";

let cachedKey: string | undefined;

export function setAnthropicKey(key: string | undefined) {
  if (key) cachedKey = key;
}

function client() {
  // Prefer SWIPE_ANTHROPIC_KEY because shell env may have an empty
  // ANTHROPIC_API_KEY="" that shadows the value in .env.local
  const key = cachedKey || process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Anthropic key not set (checked SWIPE_ANTHROPIC_KEY and ANTHROPIC_API_KEY)");
  return new Anthropic({ apiKey: key });
}

export async function templatizePost(postText: string): Promise<string> {
  const c = client();
  const res = await c.messages.create({
    model: FAST_MODEL,
    max_tokens: 1024,
    system:
      "You convert viral LinkedIn posts into reusable fill-in-the-blank templates. Keep the structure, hook style, line breaks, and rhythm. Replace specific names, numbers, industries, and anecdotes with bracketed placeholders like {industry}, {specific number}, {personal failure}, {target audience}. Output ONLY the template, no commentary.",
    messages: [{ role: "user", content: postText }],
  });
  logAnthropicUsage("templatize", FAST_MODEL, res.usage.input_tokens, res.usage.output_tokens);
  const block = res.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text.trim();
}

export async function classifyVisual(imageUrl: string): Promise<"photo" | "graphic"> {
  const c = client();
  const res = await c.messages.create({
    model: FAST_MODEL,
    max_tokens: 16,
    system:
      'Classify the image as either "photo" (a real photograph of people, places, or things) or "graphic" (a designed visual: infographic, chart, slide, screenshot, illustration, text-on-background). Reply with one word only.',
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "url", url: imageUrl } }],
    }],
  });
  logAnthropicUsage("classify_visual", FAST_MODEL, res.usage.input_tokens, res.usage.output_tokens);
  const block = res.content[0];
  if (block.type !== "text") return "photo";
  const t = block.text.trim().toLowerCase();
  return t.startsWith("graphic") ? "graphic" : "photo";
}

export async function imagePrompt(
  imageUrl: string,
  brandColors: { name?: string; hex: string }[],
  clientName: string,
): Promise<string> {
  const c = client();
  const palette = brandColors.map((c) => `${c.hex}${c.name ? ` (${c.name})` : ""}`).join(", ");
  const res = await c.messages.create({
    model: SMART_MODEL,
    max_tokens: 1024,
    system:
      `You write detailed image-generation prompts that recreate a reference graphic in a different brand's color palette. Analyze layout, typography style, iconography, hierarchy, and composition. Then output a single prompt suitable for an image generation model (Midjourney/DALL-E style) that reproduces the same design intent for client "${clientName}" using ONLY these colors: ${palette}. Preserve text content verbatim. Output ONLY the prompt.`,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "url", url: imageUrl } },
        { type: "text", text: "Generate the recreation prompt." },
      ],
    }],
  });
  logAnthropicUsage("image_prompt", SMART_MODEL, res.usage.input_tokens, res.usage.output_tokens, { client: clientName });
  const block = res.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text.trim();
}
