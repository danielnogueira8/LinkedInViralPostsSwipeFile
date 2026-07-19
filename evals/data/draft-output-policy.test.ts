import { describe, expect, test } from "vitest";
import {
  evaluateDraftOutput,
  requestedCharacterRange,
  unsupportedFactualSpecific,
  withoutOutputControlQuantities,
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
import { INCOMPLETE_ORIGINAL_POST_BODY } from "../fixtures/cowork-incidents";

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
    for (const instruction of [
      "Write a post. Exactly 800 characters.",
      "Write it in 800 characters.",
      "Rewrite it to 800 characters.",
      "Keep it at 800 characters.",
    ]) {
      expect(requestedCharacterRange(instruction)).toEqual({
        min: 800,
        max: 800,
      });
    }
    expect(requestedCharacterRange("Make it concise and punchy.")).toBeNull();
  });

  test("enforces an exact character target on final output", () => {
    const policy = {
      characterRange: { min: 800, max: 800 },
      groundingContext: "",
    };
    expect(validateDraftOutput("x".repeat(799), policy).ok).toBe(false);
    expect(validateDraftOutput("x".repeat(800), policy).ok).toBe(true);
    expect(validateDraftOutput("x".repeat(801), policy).ok).toBe(false);
  });

  test("compares the character range against trimmed length, ignoring surrounding whitespace", () => {
    // The model sometimes wraps a candidate in leading/trailing whitespace
    // (a stray newline, a trailing space). Comparing against the raw,
    // untrimmed length made an honest exact-800-char draft fail as
    // "801 characters" purely because of whitespace the user never asked
    // to be counted — the sibling too_short check already trims for the
    // same reason (draft-output-policy.ts).
    const policy = {
      characterRange: { min: 800, max: 800 },
      groundingContext: "",
    };
    expect(validateDraftOutput(`  ${"x".repeat(800)}  `, policy)).toMatchObject({
      ok: true,
    });
    expect(validateDraftOutput(`\n${"x".repeat(800)}\n`, policy)).toMatchObject({
      ok: true,
    });
    // Padding a genuinely too-short draft with whitespace still correctly
    // fails — the fix compares trimmed length, it does not stop counting.
    const tooShort = validateDraftOutput(`  ${"x".repeat(799)}  `, policy);
    expect(tooShort.ok).toBe(false);
    expect(tooShort.ok === false ? tooShort.error : "").toContain("799 characters");
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

  test("allows structural framework counts while source factuality is enforced", () => {
    const body = [
      "3 reasons founders should publish early.",
      "",
      "1. Build familiarity before launch.",
      "2. Learn which message resonates.",
      "3. Improve the thinking in public.",
    ].join("\n");
    expect(
      validateDraftOutput(body, {
        characterRange: null,
        groundingContext: "",
        enforceFactualSpecificity: true,
      }).ok,
    ).toBe(true);
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

  test("a first-person claim grounded in a voice exemplar is not rejected", () => {
    // Regression for the exemplar-grounding gap (#119): voiceGroundingContext
    // now includes the user's own exemplar posts, so a draft that faithfully
    // echoes an exemplar's first-person specifics counts as supported instead
    // of a false unsupported_claim. Exemplars are real user posts, verbatim.
    const claim =
      "My team deleted seven onboarding emails and activation rose 17%.";
    const exemplarGrounding =
      "My team deleted seven onboarding emails.\n\nActivation rose 17%.\n\nLess guidance. Faster value.";
    // Without the exemplar, this first-person team-result claim IS flagged...
    expect(
      unsupportedFirstPersonClaim(claim, "Direct, practical founder voice."),
    ).not.toBeNull();
    // ...but with the exemplar in grounding (as the fix now provides), it's
    // supported — proving it's the exemplar that makes the claim legitimate.
    expect(unsupportedFirstPersonClaim(claim, exemplarGrounding)).toBeNull();
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

  test("rejects invented people-I-hear-from relationship anecdotes", () => {
    expect(
      unsupportedFirstPersonClaim(
        "The most common excuse I hear from founders is that they'll publish once the feature ships.",
        "Verified backstory: 6 years experience as a ghostwriter for founders.",
      ),
    ).toMatch(/hear from founders/i);
  });

  test.each([
    "I see founders wait months to say anything publicly.",
    "I watch operators hide behind another polish round.",
    "I advise clients to publish before the product is finished.",
  ])("rejects unsupported present-tense experience claims: %s", (claim) => {
    expect(
      unsupportedFirstPersonClaim(
        claim,
        "The user asked for a post about publishing before a product feels ready.",
      ),
    ).toBe(claim);
  });

  test("rejects an unsupported first-person source-hook transplant", () => {
    expect(
      unsupportedFirstPersonClaim(
        "I successfully broke every rule that says wait until your product feels ready.",
        "Verified backstory: 6 years experience as a ghostwriter for founders.",
      ),
    ).toMatch(/successfully broke every rule/i);
  });

  test("rejects a hook fragment when a complete modeled post is required", () => {
    expect(
      validateDraftOutput(
        "Waiting for ready is the fastest way to stay invisible.",
        {
          characterRange: null,
          groundingContext: "",
          minimumCompletePostChars: 180,
        },
      ).ok,
    ).toBe(false);
  });

  test("rejects the exact production draft that stopped mid-sentence despite valid tool JSON", () => {
    expect(
      validateDraftOutput(INCOMPLETE_ORIGINAL_POST_BODY, {
        characterRange: null,
        groundingContext: "",
        requireCompletePost: true,
      }),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/unfinished|complete/i),
    });
  });

  test.each([
    "A personal brand compounds while you sleep.\n\nStart before you're ready",
    "Some people persist.\n\nMost people quit",
    "The work creates the confidence.\n\nThe choice is yours",
    "Make your values visible.\n\nChoose what you stand for",
    "The people matter.\n\nBuild with people you trust",
    "Do work worth defending.\n\nBecome someone others believe in",
    "Keep the receipts.\n\nThis is the work I am proud of",
  ])("allows an intentional unpunctuated LinkedIn ending: %s", (body) => {
    expect(
      validateDraftOutput(body, {
        characterRange: null,
        groundingContext: "",
        requireCompletePost: true,
      }).ok,
    ).toBe(true);
  });

  test.each([
    "The idea is useful.\n\nIt only works when",
    "Here is the framework.\n\n1.",
    "The real question is:",
  ])("rejects another high-confidence unfinished ending: %s", (body) => {
    expect(
      validateDraftOutput(body, {
        characterRange: null,
        groundingContext: "",
        requireCompletePost: true,
      }).ok,
    ).toBe(false);
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

  test("treats hooks for a post as the deliverable, not the referenced post", () => {
    expect(
      requestsPartialTextDeliverable(
        "Give me 6 scroll-stopping hooks for a LinkedIn post about why founders should post before their content is perfect.",
      ),
    ).toBe(true);
    expect(
      requestsPartialTextDeliverable(
        "Give me one LinkedIn post about why strong hooks matter.",
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

  test("recognizes exact-these-fields wording as a fields-only contract", () => {
    const exactFieldsContract = derivePartialTextContract(
      "Give me exactly 3 ideas. For each idea, include exactly these fields: Angle, Hook, Takeaway. No intro or closing.",
    );
    expect(exactFieldsContract).toMatchObject({
      expectedCount: 3,
      requiredFields: ["Angle", "Hook", "Takeaway"],
      fieldsOnly: true,
      forbidFraming: true,
    });
    expect(
      validatePartialTextOutput(
        "1. Angle: One\nHook: One\nTakeaway: One\nProof: Extra\n\n2. Angle: Two\nHook: Two\nTakeaway: Two\n\n3. Angle: Three\nHook: Three\nTakeaway: Three",
        exactFieldsContract,
      ).ok,
    ).toBe(false);
  });

  test("rejects unsupported numeric pseudo-specifics in no-search text", () => {
    expect(
      unsupportedFactualSpecific(
        "1. Angle: Editing\nHook: The AI draft was 90% there. The last 10% was all that mattered.",
        "Give me exactly 3 ideas about AI writing. Do not search or use tools.",
      ),
    ).toMatch(/90%/);
  });

  test("deliverable counts and character limits are not factual grounding", () => {
    const context = withoutOutputControlQuantities(
      "Write exactly 3 hooks under 1,200 characters about how I closed 7 clients.",
    );

    expect(context).not.toMatch(/\b3\b/);
    expect(context).not.toMatch(/1,200/);
    expect(context).toContain("7 clients");
    expect(
      unsupportedFactualSpecific(
        "Hook: A founder generated $3M from 1,200 customers.",
        context,
      ),
    ).toMatch(/\$3M/);
    expect(
      unsupportedFactualSpecific("Hook: I closed 7 clients.", context),
    ).toBeNull();
  });

  test("rejects unsupported bare numeric activity claims but permits structural framework counts", () => {
    const policy = {
      characterRange: null,
      groundingContext: "Write a post about outbound discipline.",
      enforceGrounding: true,
      enforceFactualSpecificity: true,
    };
    for (const claim of [
      "I sent 50 DMs before breakfast and learned what converts.",
      "A founder sent 50 DMs before breakfast and learned what converts.",
      "We booked 12 calls in a week by changing one line.",
      "A founder sold 3 things before breakfast.",
      "Only 3 strategies generated demand.",
    ]) {
      expect(validateDraftOutput(claim, policy).ok).toBe(false);
    }
    expect(
      validateDraftOutput(
        "3 reasons public proof compounds:\n\n1. It travels.\n2. It teaches.\n3. It earns trust.",
        policy,
      ).ok,
    ).toBe(true);
  });

  test("permits DESCRIPTOR counts on bullet/arrow list items but still rejects metrics there", () => {
    // A lead-magnet giveaway lists WHAT'S INSIDE with arrow/bullet items whose
    // number describes a noun ("4 Specialized Agents", "3 Templates") — a
    // descriptor, not a transplanted metric. This exact draft used to fail
    // ("→ Claude Prompts For 4 Specialized Agents" flagged as a numeric claim).
    const policy = {
      characterRange: null,
      groundingContext: "Write a lead-magnet post about a cold-email checklist.",
      enforceGrounding: true,
      enforceFactualSpecificity: true,
    };
    const giveaway = [
      "I packaged everything into one free resource.",
      "",
      "Here's what's inside:",
      "→ Claude Prompts For 4 Specialized Agents",
      "→ 3 Cold-Email Templates you can paste today",
      "→ 5 Reply Scripts for the first hour",
      "",
      "Comment CHECKLIST and I'll send it.",
    ].join("\n");
    expect(validateDraftOutput(giveaway, policy).ok).toBe(true);

    // But a real fabricated METRIC on a bullet line is STILL rejected — the
    // exemption is for descriptor counts, not results.
    for (const claim of [
      "→ Booked 12 calls in the first week",
      "→ Grew reply rates by 40%",
      "→ Closed 3 deals in 6 weeks",
    ]) {
      expect(validateDraftOutput(claim, policy).ok).toBe(false);
    }
  });

  test("rejects a cleanly punctuated list that promises more items than it delivers", () => {
    const truncated = [
      "4 ways to build career leverage:",
      "",
      "1. Publish useful decisions.",
      "Explain the tradeoff while the lesson is fresh.",
      "",
      "2. Make proof easy to inspect.",
      "A reader should understand how you think before a call.",
    ].join("\n");
    const complete = `${truncated}\n\n3. Teach the mechanism.\nShow why the lesson works.\n\n4. Keep publishing.\nTrust compounds through repetition.`;
    const completenessPolicy = {
      characterRange: null,
      groundingContext: "Write about career leverage.",
      enforceGrounding: true,
      enforceFactualSpecificity: true,
      minimumCompletePostChars: 180,
      requireCompletePost: true,
    };

    expect(validateDraftOutput(truncated, completenessPolicy).ok).toBe(false);
    expect(validateDraftOutput(complete, completenessPolicy).ok).toBe(true);
  });

  test("numeric grounding requires a local matching fact, not metadata or the same number with another unit", () => {
    const metadata = JSON.stringify({
      source_post_count: 3,
      generated_at: "2026-07-15T10:00:00Z",
    });
    expect(
      unsupportedFactualSpecific(
        "A founder sold 3 companies in 2026.",
        metadata,
      ),
    ).toMatch(/3 companies/);
    expect(
      unsupportedFactualSpecific(
        "I closed 6 clients.",
        "I have 6 years of writing experience.",
      ),
    ).toMatch(/6 clients/);
    expect(
      unsupportedFactualSpecific(
        "I closed 6 clients.",
        "Verified user fact: I closed 6 clients after changing the offer.",
      ),
    ).toBeNull();
    expect(
      unsupportedFactualSpecific(
        "90% of posts failed.",
        "I wrote 90 posts for founders.",
      ),
    ).toMatch(/90%/);
    expect(
      unsupportedFactualSpecific(
        "A founder charged $5 per client.",
        "The founder worked with 5 clients.",
      ),
    ).toMatch(/\$5/);
    expect(
      unsupportedFactualSpecific(
        "A founder closed 3 clients.",
        '{"summary":"Direct writing for founders and clients","source_post_count":3}',
      ),
    ).toMatch(/3 clients/);
    expect(
      unsupportedFactualSpecific(
        "A founder sold 3 companies in 2026.",
        '{"summary":"Direct writing for founders and companies","source_post_count":3,"generated_at":"2026-07-15"}',
      ),
    ).toMatch(/3 companies/);
  });

  test.each([
    "A founder closed three clients before lunch.",
    "Only seven strategies generated demand.",
    "Three clients bought the offer.",
  ])("rejects unsupported spelled-out factual counts: %s", (body) => {
    const policy = {
      characterRange: null,
      groundingContext: "Write about founder-led sales.",
      enforceFactualSpecificity: true,
    };
    expect(validateDraftOutput(body, policy).ok).toBe(false);
    expect(unsupportedFactualSpecific(body, policy.groundingContext)).not.toBeNull();
  });

  test.each([
    "A useful post makes one honest claim.",
    "There are two kinds of career leverage: skills and proof.",
    "Your personal brand has one job: make your judgment visible.",
    "I believe one lesson matters more than the rest.",
    "You only need one useful idea to start.",
    "The first step is to publish one useful decision.",
  ])("allows qualitative rhetorical number words: %s", (body) => {
    expect(
      validateDraftOutput(body, {
        characterRange: null,
        groundingContext: "Write an original post about building career leverage.",
        enforceFactualSpecificity: true,
      }).ok,
    ).toBe(true);
  });

  test.each([
    "Three strategies generated demand.",
    "Three tactics generated demand.",
    "Three ideas generated revenue.",
    "Three things sold before lunch.",
    "Three reasons generated demand.",
  ])("does not disguise a factual result as a structural header: %s", (body) => {
    expect(
      validateDraftOutput(body, {
        characterRange: null,
        groundingContext: "",
        enforceFactualSpecificity: true,
      }).ok,
    ).toBe(false);
  });

  test("rejects assistant framing but permits an in-post here's opening", () => {
    const policy = {
      characterRange: null,
      groundingContext: "",
      requireCompletePost: true,
    };
    expect(
      evaluateDraftOutput(
        "Here is the LinkedIn post you asked for:\n\nThe actual body starts here.",
        policy,
      ),
    ).toMatchObject({ ok: false, code: "assistant_framing" });
    expect(
      evaluateDraftOutput("Here’s what changed when I simplified the offer.", policy)
        .ok,
    ).toBe(true);
  });
});
