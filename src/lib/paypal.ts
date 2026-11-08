// PayPal Invoicing v2 client.
// Uses the real PayPal sandbox when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are set,
// otherwise an in-memory mock with the same response shapes (so the app runs without keys).

import type { DraftItem, InvoiceDraft, InvoiceRow, InvoiceStatus } from "./types";
import { addDays, isoDate, newId, store, today } from "./store";

const BASE =
  process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const isMock = !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET;

// ---------- PayPal response shapes (only the fields we use) ----------

interface Money {
  currency_code: string;
  value: string;
}

export interface PPInvoice {
  id: string;
  status: InvoiceStatus;
  detail: {
    invoice_number?: string;
    invoice_date?: string;
    currency_code: string;
    note?: string;
    payment_term?: { term_type?: string; due_date?: string };
    metadata?: { recipient_view_url?: string; create_time?: string };
  };
  primary_recipients?: {
    billing_info?: {
      name?: { given_name?: string; surname?: string; full_name?: string };
      email_address?: string;
      business_name?: string;
    };
  }[];
  items?: {
    name: string;
    description?: string;
    quantity: string;
    unit_amount: Money;
    unit_of_measure?: string;
  }[];
  amount?: Money;
  due_amount?: Money;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

// ---------- HTTP ----------

let tokenCache: { token: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString(
    "base64",
  );
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) throw new PayPalError("PayPal auth failed — check PAYPAL_CLIENT_ID/SECRET", res.status);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

async function pp<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const issue = json?.details?.[0];
    const msg = issue
      ? [issue.issue, issue.description, issue.field ? `(${issue.field})` : ""].filter(Boolean).join(" ")
      : json?.message ?? `PayPal ${method} ${path} failed`;
    throw new PayPalError(msg, res.status, json);
  }
  return json as T;
}

// ---------- Helpers ----------

const money = (value: number, currency: string): Money => ({
  currency_code: currency,
  value: value.toFixed(2),
});

export function draftTotals(d: Pick<InvoiceDraft, "items" | "tax_percent" | "discount_percent">) {
  const subtotal = d.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const discount = subtotal * ((d.discount_percent ?? 0) / 100);
  const tax = (subtotal - discount) * ((d.tax_percent ?? 0) / 100);
  return { subtotal, discount, tax, total: Math.round((subtotal - discount + tax) * 100) / 100 };
}

function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { given_name: parts[0], surname: "" };
  return { given_name: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
}

function toPayPalItems(items: DraftItem[], currency: string, taxPercent: number | null) {
  return items.map((i) => ({
    name: i.name.slice(0, 200),
    ...(i.description ? { description: i.description.slice(0, 1000) } : {}),
    quantity: String(i.quantity),
    unit_amount: money(i.unit_price, currency),
    unit_of_measure: i.unit,
    ...(taxPercent ? { tax: { name: "Tax", percent: String(taxPercent) } } : {}),
  }));
}

function buildInvoiceBody(d: InvoiceDraft, invoiceNumber: string, invoiceDate: string) {
  const invoicerName = process.env.INVOICER_NAME ?? "Alex Rivera";
  return {
    detail: {
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      currency_code: d.currency,
      note: d.note_to_client.slice(0, 4000),
      term: "Thanks for your business!",
      payment_term: { due_date: d.due_date },
    },
    invoicer: {
      name: splitName(invoicerName),
      ...(process.env.INVOICER_BUSINESS ? { business_name: process.env.INVOICER_BUSINESS } : {}),
      ...(process.env.INVOICER_EMAIL ? { email_address: process.env.INVOICER_EMAIL } : {}),
    },
    primary_recipients: [
      {
        billing_info: {
          name: splitName(d.client_name),
          email_address: d.client_email ?? undefined,
          ...(d.client_business ? { business_name: d.client_business } : {}),
        },
      },
    ],
    items: toPayPalItems(d.items, d.currency, d.tax_percent),
    configuration: { tax_calculated_after_discount: true, tax_inclusive: false },
    ...(d.discount_percent
      ? { amount: { breakdown: { discount: { invoice_discount: { percent: String(d.discount_percent) } } } } }
      : {}),
  };
}

// ---------- Mock backend ----------

const mockState = globalThis as unknown as { __duelyMock?: PPInvoice[] };
const mockInvoices = (mockState.__duelyMock ??= []);

function mockCreate(d: InvoiceDraft, invoiceDate: string, status: InvoiceStatus): PPInvoice {
  const { total } = draftTotals(d);
  const id = newId("INV2").toUpperCase();
  const inv: PPInvoice = {
    id,
    status,
    detail: {
      invoice_number: String(1000 + mockInvoices.length + 1),
      invoice_date: invoiceDate,
      currency_code: d.currency,
      note: d.note_to_client,
      payment_term: { due_date: d.due_date },
      metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` },
    },
    primary_recipients: [
      {
        billing_info: {
          name: { ...splitName(d.client_name), full_name: d.client_name },
          email_address: d.client_email ?? undefined,
          business_name: d.client_business ?? undefined,
        },
      },
    ],
    items: toPayPalItems(d.items, d.currency, d.tax_percent),
    amount: money(total, d.currency),
    due_amount: money(status === "PAID" ? 0 : total, d.currency),
  };
  mockInvoices.unshift(inv);
  return inv;
}

function mockFind(id: string) {
  const inv = mockInvoices.find((i) => i.id === id);
  if (!inv) throw new PayPalError("RESOURCE_NOT_FOUND: invoice not found", 404);
  return inv;
}

// ---------- Public API ----------

export async function listInvoices(): Promise<PPInvoice[]> {
  if (isMock) return mockInvoices;
  const all: PPInvoice[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await pp<{ items?: PPInvoice[]; total_pages?: number }>(
      "GET",
      `/v2/invoicing/invoices?page=${page}&page_size=100&total_required=true`,
    );
    all.push(...(res.items ?? []));
    if (!res.total_pages || page >= res.total_pages) break;
  }
  return all;
}

export async function getInvoice(id: string): Promise<PPInvoice> {
  if (isMock) return mockFind(id);
  return pp<PPInvoice>("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
}

/** Creates a draft invoice in PayPal and sends it to the client. */
export async function createAndSendInvoice(
  d: InvoiceDraft,
  opts: { invoiceDate?: string; send?: boolean } = {},
): Promise<PPInvoice> {
  const invoiceDate = opts.invoiceDate ?? isoDate(today());
  const send = opts.send ?? true;
  if (isMock) return mockCreate(d, invoiceDate, send ? "SENT" : "DRAFT");

  const { invoice_number } = await pp<{ invoice_number: string }>(
    "POST",
    "/v2/invoicing/generate-next-invoice-number",
  );
  const created = await pp<PPInvoice>("POST", "/v2/invoicing/invoices", buildInvoiceBody(d, invoice_number, invoiceDate));
  if (!send) return created;
  await pp("POST", `/v2/invoicing/invoices/${created.id}/send`, {
    send_to_invoicer: false,
    send_to_recipient: true,
    subject: `Invoice #${invoice_number} from ${process.env.INVOICER_BUSINESS ?? process.env.INVOICER_NAME ?? "your freelancer"}`,
  });
  return getInvoice(created.id);
}

export async function sendReminder(id: string, subject: string, note: string) {
  if (isMock) {
    const inv = mockFind(id);
    if (!["SENT", "UNPAID", "PARTIALLY_PAID"].includes(inv.status))
      throw new PayPalError(`Cannot remind an invoice in status ${inv.status}`, 422);
    return;
  }
  await pp("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
    subject: subject.slice(0, 200),
    note: note.slice(0, 4000),
    send_to_invoicer: false,
    send_to_recipient: true,
  });
}

/** Records a payment received outside PayPal (bank transfer, cash, …). */
export async function recordExternalPayment(id: string, note = "Recorded in Duely") {
  const inv = await getInvoice(id);
  const due = inv.due_amount ?? inv.amount;
  if (!due) throw new PayPalError("Invoice has no amount", 422);
  if (isMock) {
    inv.status = "MARKED_AS_PAID";
    inv.due_amount = money(0, due.currency_code);
    return;
  }
  await pp("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
    method: "BANK_TRANSFER",
    payment_date: isoDate(new Date()),
    amount: due,
    note,
  });
}

/** Mock only: simulate the client paying through the PayPal payer link. */
export function mockClientPays(id: string) {
  const inv = mockFind(id);
  inv.status = "PAID";
  inv.due_amount = money(0, inv.detail.currency_code);
}

export async function cancelInvoice(id: string) {
  if (isMock) {
    mockFind(id).status = "CANCELLED";
    return;
  }
  await pp("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, {
    subject: "Invoice cancelled",
    note: "This invoice has been cancelled. No payment is needed.",
    send_to_invoicer: false,
    send_to_recipient: true,
  });
}

/** Verifies a webhook really came from PayPal. */
export async function verifyWebhook(headers: Headers, event: unknown): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (isMock || !webhookId) return false;
  const res = await pp<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return res.verification_status === "SUCCESS";
}

// ---------- Normalisation ----------

const OPEN: InvoiceStatus[] = ["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "PAYMENT_PENDING"];
const PAID: InvoiceStatus[] = ["PAID", "MARKED_AS_PAID", "REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED"];

/** The list endpoint omits the payer link; it follows a fixed pattern from the invoice id. */
function payerViewUrl(inv: PPInvoice): string | null {
  if (isMock || inv.status === "DRAFT" || !inv.id.startsWith("INV2-")) return null;
  const host = process.env.PAYPAL_ENV === "live" ? "www.paypal.com" : "www.sandbox.paypal.com";
  return `https://${host}/invoice/p/#${inv.id.slice(5).replaceAll("-", "")}`;
}

export function toRow(inv: PPInvoice): InvoiceRow {
  const bi = inv.primary_recipients?.[0]?.billing_info;
  const name =
    bi?.name?.full_name ||
    [bi?.name?.given_name, bi?.name?.surname].filter(Boolean).join(" ") ||
    bi?.business_name ||
    bi?.email_address ||
    "Unknown client";
  const dueDate = inv.detail.payment_term?.due_date ?? null;
  const daysOverdue = dueDate
    ? Math.round((today().getTime() - new Date(dueDate + "T00:00:00Z").getTime()) / 86_400_000)
    : null;
  const total = Number(inv.amount?.value ?? 0);
  const amountDue = PAID.includes(inv.status) ? 0 : Number(inv.due_amount?.value ?? total);

  let health: InvoiceRow["health"] = "Open";
  if (PAID.includes(inv.status)) health = "Paid";
  else if (inv.status === "DRAFT") health = "Draft";
  else if (inv.status === "CANCELLED") health = "Cancelled";
  else if (OPEN.includes(inv.status) && daysOverdue !== null && daysOverdue > 0) health = "Overdue";
  else if (OPEN.includes(inv.status) && daysOverdue !== null && daysOverdue >= -3) health = "Due soon";

  const reminders = store.reminders[inv.id] ?? [];
  return {
    id: inv.id,
    number: inv.detail.invoice_number ?? inv.id,
    status: inv.status,
    health,
    clientName: name,
    clientEmail: bi?.email_address ?? "",
    clientBusiness: bi?.business_name ?? null,
    currency: inv.detail.currency_code,
    total,
    amountDue,
    invoiceDate: inv.detail.invoice_date ?? "",
    dueDate,
    daysOverdue,
    payerUrl: inv.detail.metadata?.recipient_view_url ?? payerViewUrl(inv),
    remindersSent: reminders.length,
    lastReminderAt: reminders[reminders.length - 1] ?? null,
  };
}

export async function listRows(): Promise<InvoiceRow[]> {
  return (await listInvoices()).map(toRow);
}

export { addDays, isoDate };
