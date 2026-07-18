import { describe, expect, test } from "vitest";
import { scorePostModelability } from "@/lib/post-modelability";

// Fixtures are shaped directly on real prod post bodies pulled while
// calibrating this scorer (2026-07-18 sample, top-reactions and thin-body
// slices of the posts table) — trimmed/paraphrased for brevity, not
// fabricated shapes.

describe("scorePostModelability — fatal rejects", () => {
  test("empty body (image/carousel-only post) rejects as caption-tier", () => {
    const r = scorePostModelability({ text: "", postType: "regular" });
    expect(r.reject).toBe("empty_or_caption");
    expect(r.score).toBe(0);
  });

  test("single-word caption rejects as caption-tier", () => {
    const r = scorePostModelability({ text: "reminder", postType: "regular" });
    expect(r.reject).toBe("empty_or_caption");
  });

  test("short engagement-bait rejects as caption-tier", () => {
    const r = scorePostModelability({ text: "Agree?", postType: "regular" });
    expect(r.reject).toBe("empty_or_caption");
  });

  test("short hiring caption under the length floor rejects as caption-tier", () => {
    const r = scorePostModelability({
      text: "We're hiring an Account Executive to free me from this hell. Please join.",
      postType: "regular",
    });
    expect(r.reject).toBe("empty_or_caption");
  });

  test("a concise post with a complete list structure is not mistaken for a caption", () => {
    const r = scorePostModelability({
      text: `Content gets easier when you stop guessing.

1. Name one reader
2. Solve one problem
3. Make one promise

Then publish.`,
      postType: "regular",
    });

    expect(r.reject).toBeNull();
    expect(r.bonuses).toContain("strong_structure");
  });

  test("video-dependent post rejects as media_dependent", () => {
    const r = scorePostModelability({
      text: "I broke down my entire growth strategy in this one. Full breakdown in the video below. Watch it end to end, I promise it's worth your time and covers everything I know about this topic in detail.",
      postType: "regular",
    });
    expect(r.reject).toBe("media_dependent");
  });

  test("carousel-swipe post rejects as media_dependent", () => {
    const r = scorePostModelability({
      text: "Swipe the carousel to see the full framework I use with every single client before we start working together — months of testing distilled into 10 slides you can screenshot and keep.",
      postType: "regular",
    });
    expect(r.reject).toBe("media_dependent");
  });

  test("a trailing, incidental video mention on an otherwise complete structured post does NOT fatally reject (real prod false-positive caught during calibration)", () => {
    // Real prod body: a complete numbered-framework post with one aside near
    // the sign-off ("Watch the video to see how I broke it down LIVE").
    // Rejecting this loses a genuinely strong modeling candidate over one
    // incidental line — the payload here is the text, not the video.
    const r = scorePostModelability({
      text: `I grew to 340k followers on LinkedIn by posting 4x/week.

You don't need to post daily here to grow.
The new LinkedIn algorithm updates also show that.

Your content gets rewarded via quality, not quantity.

Here's a simple structure you can use this week:

I call it the '4-3-2-1' Framework:

4 posts a week (non-negotiable)
3 content pillars (educate, storytell and sell)
2 types of audiences (followers and customers)
1 lead magnet every week (to convert to email).

That's it. That's your system for the week.

Pick a pillar. Solve a problem. Use an 8 word hook.
I put a short (and free) LinkedIn guide for you to use here: https://example.com/guide

Watch the video to see how I broke it down LIVE.

PS: Tell me which part of writing content you struggle with the most!`,
      postType: "regular",
    });
    expect(r.reject).toBeNull();
    expect(r.bonuses).toContain("strong_structure");
  });

  test("a media pointer in the OPENING line still fatally rejects even in a long post", () => {
    const r = scorePostModelability({
      text: `Watch the video below for the full breakdown of everything I learned this year.

I go through every single lesson in detail, with real examples from clients, and I promise it's worth the full 12 minutes if you're serious about growing on this platform in 2026.

There's a framework at the 4 minute mark that alone is worth the watch, plus a template you can steal directly from the screen recording.`,
      postType: "regular",
    });
    expect(r.reject).toBe("media_dependent");
  });

  test("a self-contained structured post is not rejected for an incidental opening media reference", () => {
    const r = scorePostModelability({
      text: `Watch the video if you want the live version. The full framework is here too.

Most content fails because it starts with a format instead of a reader problem.

1. Name the exact reader.
2. Name the expensive problem.
3. Explain the smallest useful change.

That sequence works for text, video, and every format in between.`,
      postType: "regular",
      mediaType: "video",
    });

    expect(r.reject).toBeNull();
    expect(r.bonuses).toContain("strong_structure");
  });

  test("a thin media caption is rejected even when its pointer is near the end", () => {
    const r = scorePostModelability({
      text: `This changed how I think about content systems and it is easier to show than explain. I included every step and example from the workshop so you can follow along without guessing. Watch the video.`,
      postType: "regular",
      mediaType: "video",
    });

    expect(r.reject).toBe("media_dependent");
  });

  test("repost stub rejects", () => {
    const r = scorePostModelability({
      text: "Reposted from Jane Doe — this is exactly the kind of thing more founders need to hear, could not have said it better myself honestly, go check out her original post for the full context.",
      postType: "regular",
    });
    expect(r.reject).toBe("repost_stub");
  });

  test("an explicit creator attribution stub rejects", () => {
    const r = scorePostModelability({
      text: "Via @janedoe — this is the clearest explanation of the problem I have seen this year, and more founders should read the original thread before making another decision about their content strategy.",
      postType: "regular",
    });
    expect(r.reject).toBe("repost_stub");
  });

  test("a post beginning with 'via' as part of its argument is not a repost stub", () => {
    const r = scorePostModelability({
      text: `Via negativa is the most useful editing principle I know.

Instead of asking what else a post needs, remove every sentence that does not strengthen the promise.

The result is shorter, clearer, and much harder to misunderstand.`,
      postType: "regular",
    });

    expect(r.reject).toBeNull();
  });

  test("a post about financial credit is not mistaken for attribution", () => {
    const r = scorePostModelability({
      text: `Credit: the least understood tool in a founder's finance stack.

Used carelessly, it compounds risk. Used deliberately, it buys time between an investment and the return that investment creates.

The useful question is not whether debt is good or bad. It is whether the repayment clock matches the value-creation clock.`,
      postType: "regular",
    });

    expect(r.reject).toBeNull();
  });

  test("poll stub rejects", () => {
    const r = scorePostModelability({
      text: "Poll: what's the biggest blocker to shipping faster on your team right now? Vote below and I'll share the results with the full breakdown next week once everyone's had a chance to weigh in.",
      postType: "regular",
    });
    expect(r.reject).toBe("poll_stub");
  });

  test("a substantive post that analyzes poll results is not a poll stub", () => {
    const r = scorePostModelability({
      text: `Our customer poll: 62% of content teams said approvals were their biggest bottleneck.

The surprising part was not the number. It was that every high-performing team had already removed one approval layer.

If publishing is slow, map the decision path before buying another writing tool.`,
      postType: "regular",
    });

    expect(r.reject).toBeNull();
  });

  test("a long two-paragraph poll analysis is not rejected only because it says poll", () => {
    const r = scorePostModelability({
      text: `Poll: most teams said speed was their biggest content problem, but that answer hid the useful distinction between drafting time and decision time.

When we reviewed the workflows, writing was rarely the bottleneck. The slow teams waited for five people to approve an idea that one accountable editor could decide. The fast teams set the audience, claim, and evidence standard before drafting began, then let one owner publish. The lesson is operational: shorten the decision path before asking writers to type faster.`,
      postType: "regular",
    });

    expect(r.reject).toBeNull();
  });
});

describe("scorePostModelability — penalties on non-rejected posts", () => {
  test("milestone/anniversary announcement is penalized but not rejected", () => {
    const r = scorePostModelability({
      text: `We completed 6 years of running this company recently. Never did we imagine it would end up creating the impact it did.

Still vividly remember the first year, when we had nothing but a shared vision and a lot of doubt from everyone around us.

Today we serve thousands of customers and the team has grown to over 40 people across three countries, and I could not be prouder of what we built together.`,
      postType: "regular",
    });
    expect(r.reject).toBeNull();
    expect(r.penalties).toContain("announcement_or_milestone");
    // Multi-paragraph structure still earns strong_structure — an
    // announcement post with real beats isn't zeroed out, just nudged down
    // relative to an equally-structured non-announcement post.
    expect(r.bonuses).toContain("strong_structure");
  });

  test("hiring announcement with real body is penalized, not rejected", () => {
    const r = scorePostModelability({
      text: `We're hiring! Remote. Competitive salary. No CV needed.

We're turning my businesses into category leaders and I'm committed to this vision for the next decade.

Here's who I'm trying to find:
1. Someone who has closed high-ticket deals before
2. Someone who can write without sounding like a robot
3. Someone who wants to build something real, not just collect a paycheck

If that's you, comment below and I'll reach out directly this week.`,
      postType: "regular",
    });
    expect(r.reject).toBeNull();
    expect(r.penalties).toContain("announcement_or_milestone");
  });

  test("wedding/personal-life post with thin body is penalized for no hook and social proof stacking", () => {
    const r = scorePostModelability({
      text: `Getting married today! God bless! Thank you to everyone who has supported me and my family, and to the 100,000+ people who have gone through my coaching or community over the years, and the 50,000+ followers who've been with me since day one, it means the world honestly.`,
      postType: "regular",
    });
    expect(r.reject).toBeNull();
    expect(r.penalties).toContain("mostly_social_proof");
  });

  test("body with no discernible hook (starts mid-thought) is penalized", () => {
    const r = scorePostModelability({
      text: "— — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —",
      postType: "regular",
    });
    expect(r.reject).toBeNull();
    expect(r.penalties).toContain("no_discernible_hook");
  });
});

describe("scorePostModelability — relative ordering", () => {
  test("an announcement post scores lower than an equally-structured non-announcement post", () => {
    const announcement = scorePostModelability({
      text: `We completed 6 years of running this company recently. Never did we imagine it would end up creating the impact it did.

Still vividly remember the first year, when we had nothing but a shared vision and a lot of doubt from everyone around us.

Today we serve thousands of customers and the team has grown to over 40 people across three countries, and I could not be prouder of what we built together.`,
      postType: "regular",
    });
    const structural = scorePostModelability({
      text: `I learned sales working at my dad's travel agency. I was 12.

While the 2008 recession forced my dad to close up shop practically overnight, I remember sitting behind the counter watching him lose client after client to bigger agencies with better pricing.

He taught me one thing that stuck with me for the rest of my career: people don't buy the cheapest option, they buy the person they trust the most in the room.

I've built three companies on that exact principle since, and it still holds up every single time I forget it and have to relearn it the hard way.`,
      postType: "regular",
    });
    expect(announcement.score).toBeLessThan(structural.score);
  });
});

describe("scorePostModelability — bonuses for genuinely modelable structure", () => {
  test("numbered-list post with a strong hook scores well above baseline", () => {
    const r = scorePostModelability({
      text: `17 misconceptions people have about LinkedIn:

1. Links lower reach. 100% incorrect. The mistake is people front-load the link instead of leading with value first.
2. You need to post daily. False. Consistency beats frequency, and 3-4 posts a week outperforms daily filler content.
3. Long posts don't get read. False. A strong hook earns the scroll, length after that barely matters if it's good.
4. Hashtags matter. They don't move the needle anymore, the algorithm mostly ignores them now.
5. You need video to grow. Text-first creators still dominate most B2B niches on this platform today.

That's just 5 of the 17 — save this post if you want the rest broken down properly.`,
      postType: "regular",
    });
    expect(r.reject).toBeNull();
    expect(r.bonuses).toContain("strong_structure");
    expect(r.bonuses).toContain("sweet_spot_length");
    expect(r.score).toBeGreaterThan(0.6);
  });

  test("multi-paragraph story post without a list still earns strong_structure", () => {
    const r = scorePostModelability({
      text: `I learned sales working at my dad's travel agency. I was 12.

While the 2008 recession forced my dad to close up shop practically overnight, I remember sitting behind the counter watching him lose client after client to bigger agencies with better pricing.

He taught me one thing that stuck with me for the rest of my career: people don't buy the cheapest option, they buy the person they trust the most in the room.

I've built three companies on that exact principle since, and it still holds up every single time I forget it and have to relearn it the hard way.`,
      postType: "regular",
    });
    expect(r.reject).toBeNull();
    expect(r.bonuses).toContain("strong_structure");
  });

  test("lead magnet with a clear comment-CTA offer earns clear_lead_magnet_offer, not a structure penalty", () => {
    const r = scorePostModelability({
      text: `I've spent the last 4+ years analysing viral LinkedIn content. 100M+ views later, there is 1 simple framework that beats every new update or algorithm change.

I broke it down into a full PDF with every pattern, every example, and the exact checklist I use before publishing anything.

Comment "FRAMEWORK" and I'll send you the whole breakdown, no opt-in required, just drop the word below and I'll DM it over within the hour.`,
      postType: "lead_magnet",
    });
    expect(r.reject).toBeNull();
    expect(r.bonuses).toContain("clear_lead_magnet_offer");
    expect(r.bonuses).toContain("strong_structure");
    expect(r.penalties).not.toContain("no_discernible_hook");
  });

  test("lead magnet with no clear offer does not earn the offer bonus", () => {
    const r = scorePostModelability({
      text: `I've been thinking a lot lately about how creators build audiences on this platform, and I think most people are overcomplicating what actually works in practice.

The truth is simpler than anyone wants to admit, and once you see it you can't unsee it in every single viral post you scroll past every day.`,
      postType: "lead_magnet",
    });
    expect(r.bonuses).not.toContain("clear_lead_magnet_offer");
  });
});

describe("scorePostModelability — score never fully zeroes a non-rejected post", () => {
  test("a mediocre but non-rejected post keeps a nonzero floor score", () => {
    const r = scorePostModelability({
      text: "x".repeat(160), // clears the caption-tier floor but has no real structure at all
      postType: "regular",
    });
    expect(r.reject).toBeNull();
    expect(r.score).toBeGreaterThan(0);
  });
});

describe("scorePostModelability — never throws on malformed input", () => {
  test("null-ish text coerces safely", () => {
    expect(() =>
      scorePostModelability({ text: undefined as unknown as string, postType: null }),
    ).not.toThrow();
  });

  test("non-string runtime text is rejected safely instead of throwing", () => {
    expect(
      scorePostModelability({
        text: { unexpected: "shape" } as unknown as string,
        postType: "regular",
      }),
    ).toMatchObject({ score: 0, reject: "empty_or_caption" });
  });
});
