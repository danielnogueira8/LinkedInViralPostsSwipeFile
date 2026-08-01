import type { Metadata } from "next";
import LandingClient from "./landing-client";
import { getLandingStats, getTopCreatorsForLanding } from "@/lib/landing-stats";

export const metadata: Metadata = {
  title: "SwipeIn · Research, draft, and schedule LinkedIn content",
  description:
    "SwipeIn finds proven LinkedIn source material, drafts in your voice, and keeps approved content moving toward publication.",
};

// Cache the stats + creator query for 5 minutes. These are global marketing
// numbers, not per-visitor — they don't need real-time freshness, and caching
// keeps the marketing route fast on a cold visit.
export const revalidate = 300;

export default async function LandingPage() {
  const [stats, topCreators] = await Promise.all([
    getLandingStats(),
    getTopCreatorsForLanding(8),
  ]);
  return <LandingClient stats={stats} topCreators={topCreators} />;
}
