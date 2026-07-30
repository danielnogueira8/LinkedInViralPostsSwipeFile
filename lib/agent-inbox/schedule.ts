// Scheduling helpers for the Agent inbox cron tick.
//
// Kept out of the route so the delivery-window and fairness rules are unit
// testable without standing up a request.

// One tick processes at most this many workspaces. The tick holds a single
// 300s function budget, and each replenish makes a model call, so the cap is
// what keeps a tick inside its deadline.
export const MAX_WORKSPACES_PER_TICK = 50;

// The inbox cron fires once an hour. A workspace is due when its local
// wall-clock has reached its delivery time, and the tick that covers a given
// local hour is the only one that will see it before the local date advances.
export const CRON_TICK_MINUTES = 60;

export function localHourMinute(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

function toMinutes(hourMinute: string): number {
  const [hours, minutes] = hourMinute.split(":");
  return Number(hours) * 60 + Number(minutes);
}

// True when this tick should replenish the workspace.
//
// The old check was `localTime >= deliveryLocalTime`, which silently dropped
// late delivery times: the cron runs at :15 past the hour, so a workspace set
// to 23:30 was never seen — 23:15 is the final tick before the local date
// rolls forward and the window is missed entirely.
//
// A workspace is due from its delivery time until the end of its local day,
// which keeps the ordinary "08:00 delivery, first tick after 08:00" case
// identical while giving late times their last-tick chance. The daily run
// claim is what stops a workspace from replenishing more than once per local
// date, so a wide window costs nothing.
export function isDueNow(
  now: Date,
  timezone: string,
  deliveryLocalTime: string,
): boolean {
  let localMinutes: number;
  try {
    localMinutes = toMinutes(localHourMinute(now, timezone));
  } catch {
    // An invalid stored timezone must not sink the whole tick. Treat it as
    // due and let claim_agent_inbox_run reject the bad zone per workspace.
    return true;
  }
  const deliveryMinutes = toMinutes(deliveryLocalTime);
  if (!Number.isFinite(deliveryMinutes)) return true;
  // Clamp so a delivery time inside the final tick of the local day still has
  // one tick that covers it.
  const lastTickStart = 24 * 60 - CRON_TICK_MINUTES;
  return localMinutes >= Math.min(deliveryMinutes, lastTickStart);
}

// Rotate the starting offset so the cap never starves the same alphabetical
// tail. listAgentInboxWorkspaces sorts by workspace id, so a plain slice(0, N)
// meant workspace N+1 onward were skipped on every tick, deterministically and
// forever. Rotating by the hour spreads the cap across the full list.
export function rotateForFairness<T>(
  items: T[],
  now: Date,
  limit: number,
): T[] {
  if (items.length <= limit) return items;
  const windows = Math.ceil(items.length / limit);
  const hoursSinceEpoch = Math.floor(now.getTime() / 3_600_000);
  const offset = (hoursSinceEpoch % windows) * limit;
  return [...items.slice(offset), ...items.slice(0, offset)].slice(0, limit);
}
