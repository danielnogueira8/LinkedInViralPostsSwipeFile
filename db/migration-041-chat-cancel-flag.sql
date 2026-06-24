-- Migration 041 — chats.cancel_requested_at
--
-- The Stop button in the chat workspace needs to actually halt the
-- server-side agent loop (not just the client's SSE read). The agent loop
-- runs in a Vercel serverless function; the Stop request comes in as a
-- SEPARATE HTTP call which may land on a different instance. So in-memory
-- cancellation isn't reliable.
--
-- A small DB flag, polled by the loop between rounds, is durable and
-- cross-instance. The stream route clears it at turn start so a stale flag
-- from a prior turn can't accidentally cancel the new one.

alter table chats
  add column if not exists cancel_requested_at timestamptz;

-- No new index — reads/writes to this column happen alongside reads/writes
-- to the chat row already, and the existing chats(id) primary key serves
-- the lookup pattern.
