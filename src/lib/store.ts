// Small store for things PayPal doesn't keep for us:
// agent proposals, reminder history, the activity feed and the demo clock.
// Kept on globalThis so it survives hot reloads in dev. When Upstash Redis
// settings are present (e.g. on Vercel), it is loaded before and saved after
// each request, so serverless instances share the same state.

import type { ActivityEvent, ReminderProposal } from "./types";

interface Store {
  proposals: ReminderProposal[];
  reminders: Record<string, string[]>; // invoiceId -> ISO timestamps
  activity: ActivityEvent[];
  clockOffsetDays: number;
  /** Line items we sent, so the AI can reuse "same rate as last time". */
  itemMemory: Record<string, { name: string; unit_price: number; unit: string; currency: string }[]>;
}

const g = globalThis as unknown as { __duelyStore?: Store; __duelyMock?: unknown[] };

export const store: Store = (g.__duelyStore ??= {
  proposals: [],
  reminders: {},
  activity: [],
  clockOffsetDays: 0,
  itemMemory: {},
});

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const REDIS_KEY = "duely:state";
let lastSaved = "";

async function redis(command: unknown[]) {
  const res = await fetch(REDIS_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return ((await res.json()) as { result: unknown }).result;
}

function snapshot() {
  return JSON.stringify({ store, mock: g.__duelyMock ?? [] });
}

/** Pull shared state from Redis into this instance (no-op without Redis). */
export async function loadStore() {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  const raw = (await redis(["GET", REDIS_KEY])) as string | null;
  if (raw) {
    const data = JSON.parse(raw) as { store: Store; mock: unknown[] };
    Object.assign(store, data.store);
    const mock = (g.__duelyMock ??= []);
    mock.splice(0, mock.length, ...(data.mock ?? []));
  }
  lastSaved = snapshot();
}

/** Push this instance's state back to Redis if it changed (no-op without Redis). */
export async function saveStore() {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  const next = snapshot();
  if (next === lastSaved) return;
  await redis(["SET", REDIS_KEY, next]);
  lastSaved = next;
}

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function logActivity(kind: ActivityEvent["kind"], message: string) {
  store.activity.unshift({ id: newId("evt"), at: new Date().toISOString(), kind, message });
  store.activity = store.activity.slice(0, 200);
}

export function recordReminder(invoiceId: string) {
  (store.reminders[invoiceId] ??= []).push(new Date().toISOString());
}

/** "Today" for the app, shifted by the demo clock so overdue flows can be shown live. */
export function today(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + store.clockOffsetDays);
  return d;
}

export function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number) {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + days);
  return c;
}
