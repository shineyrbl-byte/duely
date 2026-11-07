"use client";

import { useState } from "react";
import type { ReminderProposal } from "@/lib/types";
import { fmtMoney, postJson } from "./api";

const URGENCY: Record<ReminderProposal["urgency"], string> = {
  "heads-up": "bg-sky-50 text-sky-700",
  gentle: "bg-emerald-50 text-emerald-700",
  firm: "bg-amber-50 text-amber-800",
  final: "bg-red-50 text-red-700",
};

function ProposalCard({ p, onDone, onError }: { p: ReminderProposal; onDone: () => void; onError: (m: string) => void }) {
  const [subject, setSubject] = useState(p.subject);
  const [note, setNote] = useState(p.note);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function decide(action: "approve" | "dismiss") {
    setBusy(true);
    try {
      await postJson(`/api/agent/proposals/${p.id}`, { action, subject, note });
      onDone();
    } catch (e) {
      onError((e as Error).message);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${URGENCY[p.urgency]}`}>{p.urgency}</span>
        <span className="font-medium">{p.clientName}</span>
        <span className="text-muted">
          · #{p.invoiceNumber} · {fmtMoney(p.amountDue, p.currency)}
          {p.daysOverdue !== null && p.daysOverdue > 0 ? ` · ${p.daysOverdue}d late` : ""}
        </span>
      </div>
      <p className="mt-1 text-xs italic text-muted">Why: {p.reasoning}</p>
      {editing ? (
        <div className="mt-3 space-y-2">
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea className="input min-h-28" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      ) : (
        <div className="mt-3 rounded-lg bg-gray-50 p-3 text-sm">
          <div className="font-medium">{subject}</div>
          <div className="mt-1 whitespace-pre-wrap text-gray-700">{note}</div>
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => decide("dismiss")}>
          Dismiss
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing((v) => !v)}>
          {editing ? "Done editing" : "Edit"}
        </button>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide("approve")}>
          {busy ? "Sending…" : "Approve & send via PayPal"}
        </button>
      </div>
    </div>
  );
}

interface Props {
  proposals: ReminderProposal[];
  aiEnabled: boolean;
  openCount: number;
  onChange: () => void;
  onError: (msg: string) => void;
}

export default function AgentPanel({ proposals, aiEnabled, openCount, onChange, onError }: Props) {
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const pending = proposals.filter((p) => p.status === "pending");
  const recent = proposals.filter((p) => p.status !== "pending").slice(0, 4);

  async function run() {
    setRunning(true);
    setSummary(null);
    try {
      const res = await postJson<{ summary: string }>("/api/agent");
      setSummary(res.summary);
      onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Collections agent</h2>
          <p className="text-sm text-muted">Reviews your {openCount} open invoice(s), checks each client&apos;s payment history and writes reminders in the right tone. Nothing goes out until you approve it.</p>
        </div>
        <button className="btn btn-primary shrink-0" onClick={run} disabled={!aiEnabled || running || openCount === 0}>
          {running ? (
            <span className="thinking">Reviewing<span>.</span><span>.</span><span>.</span></span>
          ) : (
            "Run review"
          )}
        </button>
      </div>

      {summary && <div className="mt-4 whitespace-pre-wrap rounded-xl bg-brand-soft px-4 py-3 text-sm text-indigo-950">{summary}</div>}

      <div className="mt-4 space-y-3">
        {pending.map((p) => (
          <ProposalCard key={p.id} p={p} onDone={onChange} onError={onError} />
        ))}
        {pending.length === 0 && !running && (
          <p className="text-sm text-muted">{summary ? "No reminders needed right now." : "No reminders waiting for approval."}</p>
        )}
      </div>

      {recent.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="label">Recent decisions</div>
          <ul className="space-y-1 text-xs text-muted">
            {recent.map((p) => (
              <li key={p.id}>
                {p.status === "sent" ? "✅ Sent" : p.status === "failed" ? "⚠️ Failed" : "⏭ Dismissed"} — {p.urgency} reminder to {p.clientName} (#{p.invoiceNumber})
                {p.error ? `: ${p.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
