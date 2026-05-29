import LandingClient from "./landing-client";
import { getLandingStats } from "@/lib/landing-stats";

// Cache the stats query for 5 minutes. These are global marketing numbers,
// not per-visitor — they don't need real-time freshness, and caching keeps
// the marketing route fast on a cold visit.
export const revalidate = 300;

export default async function LandingPage() {
  const stats = await getLandingStats();
  return <LandingClient stats={stats} />;
}
