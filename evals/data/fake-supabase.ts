// A tiny in-memory stand-in for the Supabase query builder, for Tier 1
// data-layer tests. It records every chained call so a test can assert the
// QUERY a tool built (which column it filtered, the ordering, the limit), and
// returns canned rows per table so it can assert the RESULT transform.
//
// Why this exists: the highest-frequency bug class is the tool querying the
// wrong thing — e.g. get_top_from_batch filtering on `scraped_at` instead of
// `posted_at` (the Klaus bug). Those bugs live entirely in the query builder
// chain, below the model, so they're cheap and deterministic to test here
// without any API or a real database.

export type Filter = { method: string; args: unknown[] };

// One recorded query against one table: every chained call in order, plus the
// terminal (await vs .maybeSingle()).
export type RecordedQuery = {
  table: string;
  selectArg?: string;
  filters: Filter[];
  terminal: "await" | "maybeSingle" | "single";
};

// What the fake returns for a given table. `rows` is the array a plain await
// resolves to; `single` is what .maybeSingle()/.single() resolves to. `error`
// forces the { data:null, error } path.
export type TableResponse = {
  rows?: Record<string, unknown>[];
  single?: Record<string, unknown> | null;
  error?: { message: string } | null;
};

export type FakeDb = {
  client: { from: (table: string) => unknown };
  queries: RecordedQuery[];
};

// Build a fake Supabase client. `responses` maps table name → what to return.
// A table with no entry resolves to empty rows / null single, no error.
export function makeFakeSupabase(responses: Record<string, TableResponse>): FakeDb {
  const queries: RecordedQuery[] = [];

  function from(table: string) {
    const rec: RecordedQuery = { table, filters: [], terminal: "await" };
    queries.push(rec);
    const resp = responses[table] ?? {};

    // A thenable builder: every chainable method returns the same proxy and
    // records the call; awaiting it (.then) resolves to { data: rows, error }.
    const builder: Record<string, unknown> = {};
    const chain = (method: string) => (...args: unknown[]) => {
      if (method === "select") rec.selectArg = args[0] as string;
      else rec.filters.push({ method, args });
      return builder;
    };
    for (const m of [
      "select",
      "eq",
      "in",
      "is",
      "gte",
      "lte",
      "order",
      "limit",
      "not",
      "neq",
      "ilike",
      // Write builders (chainable, same as filters): a mutation like
      // .update(patch).eq("id", x).eq("workspace_id", ws).select().maybeSingle()
      // records each call so tests can assert the scoping, and the terminal
      // (.maybeSingle/.single/await) resolves to the canned single/rows.
      "update",
      "insert",
      "upsert",
      "delete",
    ]) {
      builder[m] = chain(m);
    }
    builder.maybeSingle = () => {
      rec.terminal = "maybeSingle";
      return Promise.resolve({ data: resp.single ?? null, error: resp.error ?? null });
    };
    builder.single = () => {
      rec.terminal = "single";
      return Promise.resolve({ data: resp.single ?? null, error: resp.error ?? null });
    };
    // Make the builder awaitable (plain `await query`): resolve to rows.
    builder.then = (
      onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
    ) => onFulfilled({ data: resp.rows ?? [], error: resp.error ?? null });

    return builder;
  }

  return { client: { from }, queries };
}

// Convenience: find the recorded query against a table (the first one).
export function queryFor(db: FakeDb, table: string): RecordedQuery | undefined {
  return db.queries.find((q) => q.table === table);
}

// Convenience: the args of the first filter call matching a method on a table.
export function filterArgs(
  db: FakeDb,
  table: string,
  method: string,
): unknown[] | undefined {
  return queryFor(db, table)?.filters.find((f) => f.method === method)?.args;
}
