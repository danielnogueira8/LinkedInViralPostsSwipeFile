import { readFile, readdir } from "node:fs/promises";

const names = (await readdir("db")).filter((name) => /^migration-\d{3}-.*\.sql$/.test(name));
const expected = Math.max(...names.map((name) => Number(name.slice(10, 13))));
const fixtureArg = process.argv.find((arg) => arg.startsWith("--fixture="));
const fixtureStatusArg = process.argv.find((arg) => arg.startsWith("--fixture-status="));
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!fixtureArg && (!url || !key)) {
  console.error(`schema readiness: expected=${expected} applied=unknown configuration=missing`);
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the target deployment.");
  process.exit(2);
}

let response;
if (fixtureArg) {
  const fixturePath = fixtureArg.slice("--fixture=".length);
  const fixtureStatus = Number(fixtureStatusArg?.slice("--fixture-status=".length) ?? 200);
  response = {
    ok: fixtureStatus >= 200 && fixtureStatus < 300,
    status: fixtureStatus,
    json: async () => JSON.parse(await readFile(fixturePath, "utf8")),
  };
} else {
  try {
    response = await fetch(`${url}/rest/v1/rpc/app_deployment_readiness`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    console.error(`schema readiness: expected=${expected} applied=unknown connection=failed`);
    process.exit(2);
  }
}
if (!response.ok) {
  console.error(`schema readiness: expected=${expected} applied=unknown rpc=unavailable status=${response.status}`);
  process.exit(1);
}
let result;
try {
  result = await response.json();
} catch {
  console.error(`schema readiness: expected=${expected} applied=unknown response=invalid`);
  process.exit(2);
}
const applied = Number(result?.applied_version ?? 0);
const missing = Array.isArray(result?.missing_capabilities) ? result.missing_capabilities : [];
console.log(`schema readiness: expected=${expected} applied=${applied} missing_capabilities=${missing.length ? missing.join(",") : "none"}`);
if (applied !== expected || missing.length) process.exit(1);
