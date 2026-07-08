#!/usr/bin/env node

const baseUrl = process.env.LOAD_TEST_BASE_URL || "http://localhost:3000";
const cookie = process.env.LOAD_TEST_COOKIE || "";
const readUsers = Number(process.env.LOAD_TEST_READ_USERS || 100);
const chatStarts = Number(process.env.LOAD_TEST_CHAT_STARTS || 20);
const weeklyStarts = Number(process.env.LOAD_TEST_WEEKLY_STARTS || 10);
const mutate = process.env.LOAD_TEST_MUTATE === "1";

const headers = cookie ? { cookie } : {};
const jsonHeaders = {
  ...headers,
  "content-type": "application/json",
};

function url(path) {
  return new URL(path, baseUrl).toString();
}

async function timed(label, fn) {
  const start = Date.now();
  try {
    const res = await fn();
    return {
      label,
      ok: res.ok,
      status: res.status,
      ms: Date.now() - start,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      status: 0,
      ms: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getPage(path, i) {
  return timed(`GET ${path} #${i}`, () =>
    fetch(url(path), {
      headers,
      redirect: "manual",
    }),
  );
}

async function createChat(i) {
  return timed(`POST /api/chats #${i}`, () =>
    fetch(url("/api/chats"), {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ title: `Load smoke ${Date.now()}-${i}` }),
    }),
  );
}

async function startWeeklyBatch(i) {
  return timed(`POST /api/batch/weekly #${i}`, () =>
    fetch(url("/api/batch/weekly"), {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    }),
  );
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function summarize(results) {
  const grouped = new Map();
  for (const result of results) {
    const key = result.label.replace(/ #\d+$/, "");
    const arr = grouped.get(key) || [];
    arr.push(result);
    grouped.set(key, arr);
  }
  for (const [key, arr] of grouped) {
    const times = arr.map((r) => r.ms);
    const ok = arr.filter((r) => r.ok || (r.status >= 300 && r.status < 400)).length;
    const failures = arr.length - ok;
    console.log(
      `${key}: ${ok}/${arr.length} ok, ${failures} failed, p50=${percentile(times, 50)}ms p95=${percentile(times, 95)}ms max=${Math.max(...times)}ms`,
    );
    const sampleFailure = arr.find((r) => !(r.ok || (r.status >= 300 && r.status < 400)));
    if (sampleFailure) {
      console.log(
        `  sample failure: status=${sampleFailure.status} error=${sampleFailure.error || ""}`,
      );
    }
  }
}

async function main() {
  console.log(`Load smoke target: ${baseUrl}`);
  console.log(
    mutate
      ? "Mutating mode enabled. This can create chats and queue weekly batches."
      : "Read-only mode. Set LOAD_TEST_MUTATE=1 and LOAD_TEST_COOKIE to exercise write-heavy routes.",
  );

  const pagePaths = [
    "/dashboard",
    "/dashboard/posts",
    "/dashboard/swipe",
    "/dashboard/lead-magnets",
  ];
  const reads = Array.from({ length: readUsers }, (_, i) =>
    getPage(pagePaths[i % pagePaths.length], i + 1),
  );
  const results = await Promise.all(reads);

  if (mutate) {
    if (!cookie) {
      throw new Error("LOAD_TEST_COOKIE is required when LOAD_TEST_MUTATE=1.");
    }
    results.push(
      ...(await Promise.all(
        Array.from({ length: chatStarts }, (_, i) => createChat(i + 1)),
      )),
    );
    results.push(
      ...(await Promise.all(
        Array.from({ length: weeklyStarts }, (_, i) => startWeeklyBatch(i + 1)),
      )),
    );
  }

  summarize(results);

  const hardFailures = results.filter(
    (r) => !(r.ok || (r.status >= 300 && r.status < 400)),
  );
  if (hardFailures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
