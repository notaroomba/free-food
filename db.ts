import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EventRow {
  id: number; dedup_key: string; message_id: string | null; thread_key: string | null; source: string | null;
  title: string; food: string | null; start_at: string; end_at: string | null;
  location: string | null; host: string | null; notes: string | null;
  leftovers: number; confidence: number | null; cancelled: number;
  sender: string | null; subject: string | null; updated_at: string;
}
export interface MessageRecord {
  id: string; receivedAt: string; sender: string | null; subject: string | null; snippet: string;
  matched: string; isFreeFood: number | null; result: string | null;
}
export interface EventInput {
  dedupKey: string; messageId: string; threadKey?: string | null; source?: string | null; title: string; food: string | null;
  startAt: string; endAt: string | null; location: string | null; host: string | null; notes: string | null;
  leftovers: boolean; confidence: number; cancelled: boolean; sender: string; subject: string;
}

const path = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/freefood.db` : './freefood.db');
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);
db.exec(`
  pragma journal_mode = wal;
  create table if not exists messages (
    id text primary key,              -- Message-ID header
    received_at text not null,
    sender text, subject text, snippet text,
    matched text,                     -- keywords that triggered the LLM ("" = skipped, "not-dormspam" = never read)
    is_free_food integer,             -- null = never analyzed
    result text,                      -- raw LLM JSON
    processed_at text not null default (datetime('now'))
  );
  create table if not exists events (
    id integer primary key,
    dedup_key text unique not null,
    message_id text,
    title text not null, food text,
    start_at text not null, end_at text,
    location text, host text, notes text,
    leftovers integer not null default 0,
    confidence real,
    cancelled integer not null default 0,
    sender text, subject text,
    updated_at text not null default (datetime('now'))
  );
  create index if not exists events_start on events(start_at);
  create table if not exists kv (k text primary key, v text);
`);
try { db.exec('alter table events add column thread_key text'); } catch { /* column exists */ }
try { db.exec('alter table events add column source text'); } catch { /* column exists */ }
// events created before the source column existed: the message log knows which came from the free-foods list
db.exec(`update events set source = case when (select matched from messages where messages.id = events.message_id) = 'free-food-list' then 'list' else 'dormspam' end where source is null`);

const q = {
  seen: db.prepare('select 1 from messages where id = ?'),
  saveMsg: db.prepare(`insert or replace into messages (id, received_at, sender, subject, snippet, matched, is_free_food, result)
    values (?, ?, ?, ?, ?, ?, ?, ?)`),
  upsert: db.prepare(`insert into events (dedup_key, message_id, title, food, start_at, end_at, location, host, notes, leftovers, confidence, cancelled, sender, subject, thread_key, source)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(dedup_key) do update set
      message_id=excluded.message_id, title=excluded.title, food=excluded.food, start_at=excluded.start_at, end_at=excluded.end_at,
      location=excluded.location, host=excluded.host, notes=excluded.notes, leftovers=excluded.leftovers,
      confidence=excluded.confidence, cancelled=excluded.cancelled, sender=excluded.sender, subject=excluded.subject,
      thread_key=excluded.thread_key, source=excluded.source, updated_at=datetime('now')`),
  deleteThread: db.prepare('delete from events where thread_key = ? and message_id != ?'),
  deleteEvent: db.prepare('delete from events where id = ?'),
  list: db.prepare('select * from events where start_at >= ? and start_at < ? order by start_at'),
  kvGet: db.prepare('select v from kv where k = ?'),
  kvSet: db.prepare('insert or replace into kv (k, v) values (?, ?)'),
  stats: db.prepare(`select count(*) as messages, sum(is_free_food) as food, (select count(*) from events) as events from messages`),
};

export const seenMessage = (id: string): boolean => !!q.seen.get(id);
export const saveMessage = (m: MessageRecord) => q.saveMsg.run(m.id, m.receivedAt, m.sender, m.subject, m.snippet, m.matched, m.isFreeFood, m.result);
export const upsertEvent = (e: EventInput) => q.upsert.run(e.dedupKey, e.messageId, e.title, e.food, e.startAt, e.endAt, e.location, e.host, e.notes,
  e.leftovers ? 1 : 0, e.confidence, e.cancelled ? 1 : 0, e.sender, e.subject, e.threadKey ?? null, e.source ?? null);
export const replaceThread = (threadKey: string, messageId: string) => q.deleteThread.run(threadKey, messageId);
export const deleteEvent = (id: number) => Number(q.deleteEvent.run(id).changes);
/** ISO UTC bounds, [from, to). */
export const listEvents = (from: string, to: string) => q.list.all(from, to) as unknown as EventRow[];
export const kvGet = (k: string): string | null => (q.kvGet.get(k) as { v: string } | undefined)?.v ?? null;
export const kvSet = (k: string, v: string | number | bigint) => q.kvSet.run(k, String(v));
export const stats = () => q.stats.get() as unknown as { messages: number; food: number | null; events: number };
