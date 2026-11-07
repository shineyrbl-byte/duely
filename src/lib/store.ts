// Small in-process store for things PayPal doesn't keep for us:
// agent proposals, reminder history, the activity feed and the demo clock.
// Kept on globalThis so it survives hot reloads in dev.

import type { ActivityEvent, ReminderProposal } from "./types";

interface Store {
  proposals: ReminderProposal[];
  reminders: Record<string, string[]>; // invoiceId -> ISO timestamps
  activity: ActivityEvent[];
  clockOffsetDays: number;
  /** Line items we sent, so the AI can reuse "same rate as last time". */
  itemMemory: Record<string, { name: string; unit_price: number; unit: string; currency: string }[]>;
}

const g = globalThis as unknown as { __duelyStore?: Store };

export const store: Store = (g.__duelyStore ??= {
  proposals: [],
  reminders: {},
  activity: [],
  clockOffsetDays: 0,
  itemMemory: {},
});

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
