import { describe, expect, test } from "vitest";
import {
  requestedCharacterRange,
  unsupportedFirstPersonClaim,
  validateDraftOutput,
} from "@/lib/agent/draft-output-policy";
import {
  derivePartialTextContract,
  validatePartialTextOutput,
} from "@/lib/agent/partial-output-policy";
import {
  explicitlyForbidsSourceDiscovery,
  isSelfContainedPartialTextRequest,
  requestsPartialTextDeliverable,
} from "@/lib/agent/source-policy";

describe("draft output policy", () => {
  test("parses explicit character ranges and one-sided limits", () => {
    expect(requestedCharacterRange("Make it 700–1,000 characters.")).toEqual({
      min: 700,
      max: 1_000,
    });
    expect(requestedCharacterRange("Keep it at most 900 chars.")).toEqual({
      max: 900,
    });
    expect(requestedCharacterRange("1,200 characters max")).toEqual({
      max: 1_200,
    });
    expect(requestedCharacterRange("Make it concise and punchy.")).toBeNull();
  });

  test("enforces both ends of a requested character range", () => {
    const policy = {
      characterRange: { min: 700, max: 1_000 },
      groundingContext: "",
    };
    expect(validateDraftOutput("x".repeat(699), policy).ok).toBe(false);
    expect(validateDraftOutput("x".repeat(700), policy).ok).toBe(true);
    expect(validateDraftOutput("x".repeat(1_000), policy).ok).toBe(true);
    expect(validateDraftOutput("x".repeat(1_001), policy).ok).toBe(false);
  });

  test("rejects the unsupported anecdote observed in production", () => {
    const body =
      "I watched this play out with two ghostwriters I know. One spent six months perfecting delivery.";
    expect(unsupportedFirstPersonClaim(body, "Direct, practical voice.")).toMatch(
      /I watched this play out/i,
    );
  });

  test("rejects progressive first-person anecdotes observed in browser QA", () => {
    const body =
      '6 months ago, I was talking to a founder who had been "almost ready" to launch for a year. Today, they have clients sliding into their DMs.';
    expect(
      unsupportedFirstPersonClaim(
        body,
        "The user writes LinkedIn content for founders.",
      ),
    ).toMatch(/I was talking to a founder/i);
  });

  test("allows opinions and user-supported backstory", () => {
    expect(
      unsupportedFirstPersonClaim(
        "I believe judgment becomes more valuable as execution gets cheaper.",
        "",
      ),
    ).toBeNull();
    expect(
      unsupportedFirstPersonClaim(
        "I spent six years running a content agency.",
        "User backstory: Ran a content agency for six years.",
      ),
    ).toBeNull();
    expect(
      unsupportedFirstPersonClaim(
        "I was talking to a founder about launching before the product felt polished.",
        "Verified backstory: I was talking to a founder about launching before the product felt polished.",
      ),
    ).toBeNull();
  });

  test("rejects invented quantitative client results despite topical overlap", () => {
    expect(
      unsupportedFirstPersonClaim(
        "I generated $5 million for my clients with LinkedIn marketing.",
        "My clients use LinkedIn marketing for their agency.",
      ),
    ).toMatch(/\$5 million/i);
    expect(
      unsupportedFirstPersonClaim(
        "I generated $5 million for my clients with LinkedIn marketing.",
        "Verified backstory: I generated $5 million for clients using LinkedIn marketing.",
      ),
    ).toBeNull();
  });

  test("rejects unsupported nonnumeric work and advisory claims", () => {
    expect(
      unsupportedFirstPersonClaim(
        "I helped founders turn their LinkedIn positioning into demand.",
        "My audience includes founders who care about LinkedIn positioning and demand.",
      ),
    ).toMatch(/I helped founders/i);
    expect(
      unsupportedFirstPersonClaim(
        "I helped founders turn their LinkedIn positioning into demand.",
        "Verified backstory: I helped founders improve LinkedIn positioning and demand.",
      ),
    ).toBeNull();
  });

  test("does not combine scattered voice facts into a fabricated anecdote", () => {
    const scatteredContext = [
      "Verified backstory: I have spent 6 years building personal brands.",
      "I have watched up close what a strong personal brand can do.",
      "Audience: founders building software products.",
    ].join("\n\n");
    expect(
      unsupportedFirstPersonClaim(
        "I watched a founder sit on a useful product for 6 months because the landing page was not polished.",
        scatteredContext,
      ),
    ).toMatch(/I watched a founder/i);
  });

  test("does not treat the same number with a different time unit as support", () => {
    const profileContext = JSON.stringify({
      summary: "A 6-year LinkedIn ghostwriter for founders.",
      exemplars: [
        "I've spent 6 years building personal brands. For clients and for myself. I've watched up close what one actually does for a person. In the last 5 months alone, the clients that I manage have had 30+ posts pass 1,000 comments each. I've seen quiet founders go from invisible to having buyers slide into their DMs.",
      ],
      backstory_guidance:
        "Verified backstory: 6 years experience as a LinkedIn ghostwriter for founders.",
    });
    expect(
      unsupportedFirstPersonClaim(
        "I've watched founders spend 6 months polishing an offer nobody has seen yet.",
        profileContext,
      ),
    ).toMatch(/6 months polishing/i);
  });

  test("accepts a locally supported ghostwriting tenure claim", () => {
    expect(
      unsupportedFirstPersonClaim(
        "I've been ghostwriting for founders for 6 years.",
        "Verified backstory: 6 years experience as a LinkedIn ghostwriter for founders.",
      ),
    ).toBeNull();
  });

  test("rejects unsupported first-person client relationships in partial ideas", () => {
    expect(
      unsupportedFirstPersonClaim(
        "The best founders I write for do not struggle to create content.",
        "The user asked for post ideas about AI and judgment.",
      ),
    ).toMatch(/founders I write for/i);
  });

  test("rejects invented people-telling-me relationship anecdotes", () => {
    expect(
      unsupportedFirstPersonClaim(
        "The ones who stall keep telling me they'll start next month when the offer is ready.",
        "Verified backstory: 6 years experience as a ghostwriter for founders.",
      ),
    ).toMatch(/telling me/i);
  });
});

describe("partial text and source opt-out policy", () => {
  test("recognizes a fully specified no-search ideas request", () => {
    const prompt =
      "Give me exactly 3 LinkedIn post ideas. Do not write full posts. Do not search for sources.";
    expect(explicitlyForbidsSourceDiscovery(prompt)).toBe(true);
    expect(requestsPartialTextDeliverable(prompt)).toBe(true);
    expect(isSelfContainedPartialTextRequest(prompt)).toBe(true);
  });

  test.each([
    "Give me 3 ideas. No sources.",
    "Give me 3 ideas without sources.",
    "Give me 3 ideas. Don't use sources.",
    "Give me 3 ideas. Don’t use any sources.",
    "Give me 3 ideas. Do not browse.",
  ])("recognizes source opt-out wording: %s", (prompt) => {
    expect(explicitlyForbidsSourceDiscovery(prompt)).toBe(true);
  });

  test("does not misclassify a full post whose subject is ideas", () => {
    expect(
      requestsPartialTextDeliverable(
        "Give me one LinkedIn post about why good ideas are not enough.",
      ),
    ).toBe(false);
    expect(
      requestsPartialTextDeliverable(
        "Find a top-performing post and rewrite it in my voice. Keep its structure and hook style.",
      ),
    ).toBe(false);
  });

  test("keeps voice-dependent partial requests on the agent path", () => {
    expect(
      isSelfContainedPartialTextRequest(
        "Give me 3 post ideas in my voice. Do not search for sources.",
      ),
    ).toBe(false);
  });
});

describe("partial text output contract", () => {
  const prompt =
    "Give me exactly 3 LinkedIn post ideas. For each idea include only: Hook, Core insight, and Proof/example. Return exactly 3 numbered items with no introduction or conclusion.";
  const contract = derivePartialTextContract(prompt);

  test("accepts exactly the requested numbered shape", () => {
    const output = [
      "1. Hook: One\nCore insight: First\nProof/example: Example one",
      "2. Hook: Two\nCore insight: Second\nProof/example: Example two",
      "3. Hook: Three\nCore insight: Third\nProof/example: Example three",
    ].join("\n\n");
    expect(validatePartialTextOutput(output, contract)).toEqual({ ok: true });
  });

  test("accepts tidy Markdown emphasis around the requested labels", () => {
    const output = [
      "1. **Hook:** One\n**Core insight:** First\n**Proof/example:** Example one",
      "2) __Hook:__ Two\n- __Core insight__: Second\n- **Proof/example**: Example two",
      "3.\n**Hook:** Three\n**Core insight:** Third\n**Proof/example:** Example three",
    ].join("\n\n");
    expect(validatePartialTextOutput(output, contract)).toEqual({ ok: true });
  });

  test.each([
    "1. Hook: One\nCore insight: First\nProof/example: Example one\n\n2. Hook: Two\nCore insight: Second\nProof/example: Example two",
    "Here are three ideas:\n\n1. Hook: One\nCore insight: First\nProof/example: Example one\n\n2. Hook: Two\nCore insight: Second\nProof/example: Example two\n\n3. Hook: Three\nCore insight: Third\nProof/example: Example three",
    "1. Hook: One\nCore insight: First\n\n2. Hook: Two\nCore insight: Second\nProof/example: Example two\n\n3. Hook: Three\nCore insight: Third\nProof/example: Example three",
  ])("rejects a response that violates the exact partial shape", (output) => {
    expect(validatePartialTextOutput(output, contract).ok).toBe(false);
  });

  test("rejects trailing conclusion copy when framing is forbidden", () => {
    const simpleContract = derivePartialTextContract(
      "Return exactly 2 numbered ideas with no introduction or conclusion.",
    );
    expect(
      validatePartialTextOutput(
        "1. First idea\n\n2. Second idea\n\nHope this helps.",
        simpleContract,
      ).ok,
    ).toBe(false);
  });
});
