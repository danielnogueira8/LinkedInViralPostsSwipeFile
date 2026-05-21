// Test fixtures for the two lead-magnet patterns shipped in lib/post-type.ts:
//   A) Comment "X" — quoted, X is a keyword or a number
//   B) Comment KEYWORD — unquoted, KEYWORD is a word in all caps (stop-listed)
//
// Tests run against the real classifyPost() so the fixture stays honest
// about production behavior.
//
// Run: npx tsx scripts/test-lead-magnet-patterns.ts

import { classifyPost } from "../lib/post-type";

function isLeadMagnet(text: string): boolean {
  return classifyPost(text).post_type === "lead_magnet";
}

// ---------- Fixtures ----------
type Case = { text: string; want: boolean; note?: string };

// Set 1: 25 cases targeted at Pattern A (quoted) — keywords AND numbers.
// Mix of real lead magnets and prose that contains the verb but no quoted CTA.
const SET_A: Case[] = [
  { text: `Comment "PLAYBOOK" and I'll DM you the doc.`, want: true },
  { text: `Drop "SCALE" below and I'll send it over.`, want: true },
  { text: `Type "GUIDE" in the comments to get access.`, want: true },
  { text: `Reply with "SWIPE" and I'll share my swipe file.`, want: true },
  { text: `Say "AI-OPS" in the comments — I'll DM the system.`, want: true },
  { text: `Comment “SYSTEM” below for the full breakdown.`, want: true, note: "curly quotes" },
  { text: `Drop 'TEMPLATE' and I'll send the Notion doc.`, want: true, note: "single quotes" },
  { text: `Comment "10" and I'll send the 10-step framework.`, want: true, note: "number keyword" },
  { text: `Drop "5" below to get the 5-prompt library.`, want: true, note: "single-digit number" },
  { text: `Type "2026" and I'll DM you the planning doc.`, want: true, note: "year as keyword" },
  { text: `Comment "LEAD GEN" for the playbook.`, want: true, note: "two-word keyword" },
  { text: `Drop "AI" and I'll send the prompt pack.`, want: true, note: "short keyword" },
  { text: `Reply with "FUNNEL" to get the breakdown.`, want: true },
  { text: `Comment "SOP" below and I'll share my Notion.`, want: true },
  { text: `Say "AUDIT" and I'll DM you the checklist.`, want: true },
  // Negatives — prose that contains the CTA verb but no quoted keyword.
  { text: `I drop in to comment on posts every morning.`, want: false, note: "verb in prose, no quotes" },
  { text: `My honest reply: this approach doesn't scale.`, want: false },
  { text: `She said the deck was great. No further notes.`, want: false },
  { text: `Comment on this if you've seen it before.`, want: false, note: "comment-as-verb, no quoted keyword" },
  { text: `Type slowly when you're tired — fewer typos.`, want: false },
  { text: `Drop the act. We both know what happened.`, want: false },
  { text: `Reply within 24 hours or the offer expires.`, want: false, note: "reply + number, no quotes" },
  { text: `I'll comment back later when I have time.`, want: false },
  { text: `Drop me a note when you're around.`, want: false },
  { text: `Comment "" if you agree.`, want: false, note: "empty quoted string — shouldn't match" },
];

// Set 2: 20 cases targeted at Pattern B (all-caps unquoted) with stop-list.
// Includes the killer false-positive cases ("Drop ONE thing...", "Comment THREE companies...").
const SET_B: Case[] = [
  // Real lead magnets — all caps, unquoted.
  { text: `Comment PLAYBOOK and I'll DM you the doc.`, want: true },
  { text: `Drop SCALE below and I'll send it.`, want: true },
  { text: `Type SYSTEM and I'll share the Notion.`, want: true },
  { text: `Reply with GUIDE to get access.`, want: true },
  { text: `Say SWIPE in the comments — I'll DM it.`, want: true },
  { text: `Comment AI-OPS for the breakdown.`, want: true, note: "hyphenated keyword" },
  { text: `Drop FUNNEL and I'll send the doc.`, want: true },
  { text: `Comment AUDIT below for the checklist.`, want: true },
  { text: `Type SOP and I'll DM the template.`, want: true },
  { text: `Drop CRM and I'll send my setup.`, want: true, note: "3-letter all-caps acronym" },
  // False-positive landmines — engagement-bait prose, NOT lead magnets.
  { text: `Drop ONE thing you'd change about your funnel.`, want: false, note: "ONE in stop-list" },
  { text: `Comment THREE companies doing this well.`, want: false, note: "THREE in stop-list" },
  { text: `Comment YES if you've felt this before.`, want: false, note: "YES in stop-list (ratio rescues real lead magnets)" },
  { text: `Drop NO if you disagree.`, want: false, note: "NO in stop-list" },
  { text: `Type THIS if you've seen it.`, want: false, note: "THIS in stop-list" },
  { text: `Comment ANY metric you care about.`, want: false, note: "ANY in stop-list" },
  { text: `Drop YOUR favorite tool below.`, want: false, note: "YOUR in stop-list" },
  // Other negatives — lowercase or non-CTA contexts.
  { text: `Drop playbook from the table — kidding.`, want: false, note: "lowercase, no match" },
  { text: `She'll comment GREAT on everything you post.`, want: false, note: "'comment' is a noun here? actually still verb — but no DM intent" },
  { text: `Comment is closed. Try again tomorrow.`, want: false, note: "'comment' as noun" },
];

// ---------- Runner ----------
function run(name: string, cases: Case[]) {
  let pass = 0;
  const fails: { i: number; c: Case; got: boolean }[] = [];
  cases.forEach((c, i) => {
    const got = isLeadMagnet(c.text);
    if (got === c.want) pass++;
    else fails.push({ i, c, got });
  });
  console.log(`\n${name}: ${pass}/${cases.length} pass`);
  for (const f of fails) {
    console.log(`  FAIL [${f.i}] want=${f.c.want} got=${f.got}: ${f.c.text}`);
    if (f.c.note) console.log(`         note: ${f.c.note}`);
  }
  return { pass, total: cases.length };
}

const a = run("Set A (quoted, 25 cases)", SET_A);
const b = run("Set B (all-caps + stop-list, 20 cases)", SET_B);

console.log(`\nTotals: A=${a.pass}/${a.total}, B=${b.pass}/${b.total}`);
const targetA = a.pass >= 24;
const targetB = b.pass >= 20;
if (targetA && targetB) {
  console.log("\n✓ Hit targets (A>=24/25, B=20/20). Safe to ship.");
  process.exit(0);
} else {
  console.log(`\n✗ Missed targets: A>=24 (${targetA}), B==20 (${targetB}).`);
  process.exit(1);
}
