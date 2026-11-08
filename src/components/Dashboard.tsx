"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { ActivityEvent, InvoiceRow, ReminderProposal } from "@/lib/types";
import AgentPanel from "./AgentPanel";
import Composer from "./Composer";
import { api, fmtMoney, postJson } from "./api";

// AG Grid touches the DOM, so render it on the client only.
const InvoiceGrid = dynamic(() => import("./InvoiceGrid"), {
  ssr: false,
  loading: () => <div className="card h-[490px] animate-pulse" />,
});

interface State {
  rows: InvoiceRow[];
  proposals: ReminderProposal[];
  activity: ActivityEvent[];
  today: string;
  clockOffsetDays: number;
  mock: boolean;
  aiEnabled: boolean;
  aiLabel: string | null;
  freelancer: string;
}

const ACTIVITY_ICON: Record<ActivityEvent["kind"], string> = {
  invoice: "🧾",
  reminder: "📨",
  payment: "💸",
  agent: "✨",
  webhook: "🔔",
  error: "⚠️",
};

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </div>
  );
}

export default function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await api<State>("/api/state"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    // Initial load plus polling, so PayPal-side payments and webhooks show up on their own.
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, 8000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 7000);
    return () => clearTimeout(t);
  }, [error]);

  async function seed() {
    setSeeding(true);
    try {
      const res = await postJson<{ notes: string[] }>("/api/demo/seed");
      if (res.notes.length) setError(res.notes.join(" "));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSeeding(false);
    }
  }

  async function setClock(offsetDays: number) {
    await postJson("/api/demo/clock", { offsetDays }).catch((e) => setError(e.message));
    refresh();
  }

  const rows = state?.rows ?? [];
  const cur = rows[0]?.currency ?? "USD";
  const open = rows.filter((r) => ["Overdue", "Due soon", "Open"].includes(r.health));
  const overdue = rows.filter((r) => r.health === "Overdue");
  const paid = rows.filter((r) => r.health === "Paid");
  const sum = (rs: InvoiceRow[], k: "amountDue" | "total") => rs.reduce((s, r) => s + r[k], 0);
  const dueSoon = open.filter((r) => r.daysOverdue !== null && r.daysOverdue <= 0 && r.daysOverdue >= -7);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-lg font-bold text-white">d</div>
          <div>
            <div className="text-lg font-semibold leading-none">Duely</div>
            <div className="text-xs text-muted">Get paid on time, {state?.freelancer.split(" ")[0] ?? "friend"}.</div>
          </div>
        </div>
        {state && (
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${state.mock ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
            {state.mock ? "Demo mode · mock PayPal" : "Connected · PayPal sandbox"}
          </span>
        )}
        {state && (
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${state.aiLabel ? "bg-brand-soft text-indigo-800" : "bg-gray-100 text-gray-500"}`}>
            {state.aiLabel ? `AI · ${state.aiLabel}` : "AI off"}
          </span>
        )}
        <div className="flex-1" />
        {state && (
          <label className="flex items-center gap-2 text-xs text-muted" title="Move the app's clock forward to demo overdue invoices">
            Demo clock
            <select className="input !w-auto !py-1 text-xs" value={state.clockOffsetDays} onChange={(e) => setClock(Number(e.target.value))}>
              {[0, 7, 14, 21, 30, 45].map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? "Today" : `+${d} days`}
                </option>
              ))}
            </select>
            <span className="font-mono">{state.today}</span>
          </label>
        )}
        <button className="btn btn-ghost btn-sm" onClick={seed} disabled={seeding}>
          {seeding ? "Loading…" : "Load demo invoices"}
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Outstanding" value={fmtMoney(sum(open, "amountDue"), cur)} sub={`${open.length} open invoice(s)`} />
        <Kpi label="Overdue" value={fmtMoney(sum(overdue, "amountDue"), cur)} sub={`${overdue.length} late`} tone={overdue.length ? "text-red-600" : ""} />
        <Kpi label="Due in 7 days" value={fmtMoney(sum(dueSoon, "amountDue"), cur)} sub={`${dueSoon.length} coming up`} />
        <Kpi label="Collected" value={fmtMoney(sum(paid, "total"), cur)} sub={`${paid.length} paid`} tone="text-emerald-700" />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Composer aiEnabled={state?.aiEnabled ?? false} onSent={refresh} />
        </div>
        <div className="space-y-6 lg:col-span-2">
          <AgentPanel
            proposals={state?.proposals ?? []}
            aiEnabled={state?.aiEnabled ?? false}
            openCount={open.length}
            onChange={refresh}
            onError={setError}
          />
          <section className="card p-5">
            <h2 className="mb-3 text-base font-semibold">Activity</h2>
            {state?.activity.length ? (
              <ul className="space-y-2 text-sm">
                {state.activity.map((a) => (
                  <li key={a.id} className="flex gap-2">
                    <span>{ACTIVITY_ICON[a.kind]}</span>
                    <span className={`flex-1 ${a.kind === "error" ? "text-red-600" : ""}`}>{a.message}</span>
                    <span className="shrink-0 text-xs text-muted">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nothing yet.</p>
            )}
          </section>
        </div>
      </div>

      <div className="mt-6">
        <InvoiceGrid rows={rows} mock={state?.mock ?? true} onChange={refresh} onError={setError} />
      </div>
    </main>
  );
}
