"use client";

import { useRef, useState } from "react";
import type { DraftItem, InvoiceDraft } from "@/lib/types";
import { api, fmtMoney, postJson } from "./api";

const EXAMPLE = `hey! so for the Brightleaf project — Marcus said the new menu boards look amazing 🙌
did 6 hrs on menu layouts + 2 rounds of revisions (another 3 hrs), same rate as last time.
also printed proofs, $45. he wants it by end of next week, net 10 is fine`;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
}

function totals(d: InvoiceDraft) {
  const subtotal = d.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const discount = subtotal * ((d.discount_percent ?? 0) / 100);
  const tax = (subtotal - discount) * ((d.tax_percent ?? 0) / 100);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}

export default function Composer({ aiEnabled, onSent }: { aiEnabled: boolean; onSent: () => void }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function toggleVoice() {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const w = window as unknown as Record<string, new () => SpeechRecognitionLike>;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setError("Voice input needs Chrome, Edge or Safari.");
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    const start = text ? text + " " : "";
    let heard = "";
    rec.onresult = (e) => {
      heard = Array.from(e.results).map((r) => r[0].transcript).join(" ");
      setText(start + heard);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  async function makeDraft() {
    setBusy("draft");
    setError(null);
    try {
      const form = new FormData();
      form.set("text", text);
      if (file) form.set("file", file);
      const { draft } = await api<{ draft: InvoiceDraft }>("/api/ai/draft", { method: "POST", body: form });
      setDraft(draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!draft) return;
    setBusy("send");
    setError(null);
    try {
      await postJson("/api/invoices", draft);
      setDraft(null);
      setText("");
      setFile(null);
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const update = (patch: Partial<InvoiceDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const updateItem = (idx: number, patch: Partial<DraftItem>) =>
    setDraft((d) => (d ? { ...d, items: d.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) } : d));

  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">New invoice from anything</h2>
          <p className="text-sm text-muted">Paste a client chat, dictate a voice note, or drop a screenshot or contract. AI drafts the invoice and you check it before PayPal sends it.</p>
        </div>
        {!draft && (
          <button className="btn btn-ghost btn-sm" onClick={() => setText(EXAMPLE)}>
            Try an example
          </button>
        )}
      </div>

      {!draft && (
        <div className="mt-4 space-y-3">
          <textarea
            className="input min-h-32 font-mono text-[13px]"
            placeholder="e.g. 'Invoice Priya at Loom Labs for 12 hours of UI work at $65/hr, due in two weeks'"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button className={`btn btn-ghost ${listening ? "!border-red-400 !text-red-600" : ""}`} onClick={toggleVoice}>
              {listening ? "● Listening… tap to stop" : "🎙 Dictate"}
            </button>
            <button className="btn btn-ghost" onClick={() => fileInput.current?.click()}>
              📎 {file ? file.name.slice(0, 28) : "Attach screenshot / PDF"}
            </button>
            {file && (
              <button className="text-xs text-muted underline" onClick={() => setFile(null)}>
                remove
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <div className="flex-1" />
            <button className="btn btn-primary" disabled={!aiEnabled || busy !== null || (!text.trim() && !file)} onClick={makeDraft}>
              {busy === "draft" ? (
                <span className="thinking">Reading<span>.</span><span>.</span><span>.</span></span>
              ) : (
                "✨ Draft invoice"
              )}
            </button>
          </div>
          {!aiEnabled && <p className="text-xs text-amber-700">Add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY to .env.local to turn on AI drafting.</p>}
        </div>
      )}

      {draft && (
        <div className="mt-4 space-y-4">
          <div className="rounded-xl bg-brand-soft px-4 py-3 text-sm text-indigo-900">
            <span className="font-medium">How the AI read it:</span> {draft.reasoning_summary}
          </div>
          {draft.missing_info.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <div className="font-medium">Check before sending</div>
              <ul className="ml-4 list-disc">
                {draft.missing_info.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label">Client name</label>
              <input className="input" value={draft.client_name} onChange={(e) => update({ client_name: e.target.value })} />
            </div>
            <div>
              <label className="label">Client email</label>
              <input
                className={`input ${!draft.client_email ? "!border-amber-400" : ""}`}
                value={draft.client_email ?? ""}
                placeholder="required"
                onChange={(e) => update({ client_email: e.target.value || null })}
              />
            </div>
            <div>
              <label className="label">Business</label>
              <input className="input" value={draft.client_business ?? ""} onChange={(e) => update({ client_business: e.target.value || null })} />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 font-medium">Item</th>
                  <th className="w-24 py-1 font-medium">Qty</th>
                  <th className="w-28 py-1 font-medium">Unit</th>
                  <th className="w-28 py-1 font-medium">Price</th>
                  <th className="w-28 py-1 text-right font-medium">Amount</th>
                  <th className="w-6" />
                </tr>
              </thead>
              <tbody>
                {draft.items.map((it, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-1 pr-2">
                      <input className="input" value={it.name} onChange={(e) => updateItem(i, { name: e.target.value })} />
                      {it.description && <div className="mt-1 text-xs text-muted">{it.description}</div>}
                    </td>
                    <td className="py-1 pr-2">
                      <input className="input" type="number" value={it.quantity} onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })} />
                    </td>
                    <td className="py-1 pr-2">
                      <select className="input" value={it.unit} onChange={(e) => updateItem(i, { unit: e.target.value as DraftItem["unit"] })}>
                        <option value="HOURS">hours</option>
                        <option value="QUANTITY">qty</option>
                        <option value="AMOUNT">flat</option>
                      </select>
                    </td>
                    <td className="py-1 pr-2">
                      <input className="input" type="number" value={it.unit_price} onChange={(e) => updateItem(i, { unit_price: Number(e.target.value) })} />
                    </td>
                    <td className="py-1 pt-3 text-right tabular-nums">{fmtMoney(it.quantity * it.unit_price, draft.currency)}</td>
                    <td className="py-1 pt-3 pl-2">
                      <button className="text-muted hover:text-red-600" title="Remove" onClick={() => update({ items: draft.items.filter((_, j) => j !== i) })}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              className="mt-1 text-xs font-medium text-brand"
              onClick={() => update({ items: [...draft.items, { name: "", description: null, quantity: 1, unit_price: 0, unit: "AMOUNT" }] })}
            >
              + Add line
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className="label">Due date</label>
              <input className="input" type="date" value={draft.due_date} onChange={(e) => update({ due_date: e.target.value })} />
            </div>
            <div>
              <label className="label">Currency</label>
              <input className="input" value={draft.currency} onChange={(e) => update({ currency: e.target.value.toUpperCase().slice(0, 3) })} />
            </div>
            <div>
              <label className="label">Tax %</label>
              <input className="input" type="number" value={draft.tax_percent ?? ""} onChange={(e) => update({ tax_percent: e.target.value ? Number(e.target.value) : null })} />
            </div>
            <div>
              <label className="label">Discount %</label>
              <input className="input" type="number" value={draft.discount_percent ?? ""} onChange={(e) => update({ discount_percent: e.target.value ? Number(e.target.value) : null })} />
            </div>
          </div>

          <div>
            <label className="label">Note to client</label>
            <textarea className="input min-h-16" value={draft.note_to_client} onChange={(e) => update({ note_to_client: e.target.value })} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div className="text-sm">
              <span className="text-muted">Total </span>
              <span className="text-lg font-semibold tabular-nums">{fmtMoney(totals(draft).total, draft.currency)}</span>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-ghost" onClick={() => setDraft(null)} disabled={busy !== null}>
                Back
              </button>
              <button className="btn btn-primary" onClick={send} disabled={busy !== null || !draft.client_email}>
                {busy === "send" ? "Sending…" : "Send via PayPal →"}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}
