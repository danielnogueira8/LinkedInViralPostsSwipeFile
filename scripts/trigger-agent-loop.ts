/**
 * Trigger the deployed agent-loop cron manually (PLAN-agent-loop Phase D).
 *
 * Runs the real cron route on the deployed app, so execution uses production
 * keys and the proper Next.js server context. Requires CRON_SECRET.
 *
 * Usage:
 *   CRON_SECRET=... npx tsx scripts/trigger-agent-loop.ts \
 *     --url https://<your-app>.vercel.app [--workspace <id>] [--cap 2]
 */

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const appUrl = arg("url") ?? process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
const workspace = arg("workspace");
const cap = arg("cap");
const secret = process.env.CRON_SECRET;

async function main() {
  if (!appUrl) throw new Error("Pass --url or set APP_URL / NEXT_PUBLIC_APP_URL");
  if (!secret) throw new Error("Set CRON_SECRET");

  const url = new URL("/api/cron/agent-loop", appUrl);
  if (workspace) url.searchParams.set("workspace", workspace);
  if (cap) url.searchParams.set("cap", cap);

  console.log(`GET ${url.toString()}`);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const text = await res.text();
  console.log(`status ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
