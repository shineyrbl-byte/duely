// Claude-powered features:
//  1. draftInvoice  – turn a messy chat / voice note / screenshot / PDF into a structured invoice draft.
//  2. runCollectionsAgent – an agent that reviews open PayPal invoices and *proposes* reminders.
//     Nothing is sent to a client until the freelancer approves it in the UI.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { listRows } from "./paypal";
import { isoDate, logActivity, newId, store, today } from "./store";
import type { InvoiceDraft, InvoiceRow, ReminderProposal } from "./types";

const MODEL = "claude-opus-5-5";
// If a request is declined by a safety classifier, the API retries it on a fallback model.
const FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

let client: Anthropic | null = null;
function claude() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_API_KEY is not set — add it to .env.local to use the AI features.");
  }
  return (client ??= new Anthropic());
}

// ---------- 1. Invoice drafting ----------

export const DraftSchema = z.object({
  client_name: z.string().describe("Person to bill. Use the business name if no person is named."),
  client_email: z.string().nullable().describe("Client email if stated or known from history, else null."),
  client_business: z.string().nullable(),
  currency: z.string().describe("ISO 4217 code, e.g. USD, EUR, INR."),
  items: z.array(
    z.object({
      name: z.string().describe("Short line item title, e.g. 'Logo design'."),
      description: z.string().nullable(),
      quantity: z.number().describe("Hours for hourly work, count for units, 1 for flat fees."),
      unit_price: z.number().describe("Price per unit in the invoice currency."),
      unit: z.enum(["HOURS", "QUANTITY", "AMOUNT"]),
    }),
  ),
  tax_percent: z.number().nullable(),
  discount_percent: z.number().nullable(),
  due_date: z.string().describe("YYYY-MM-DD."),
  note_to_client: z.string().describe("A short, warm note shown on the invoice (max ~3 sentences)."),
  missing_info: z
    .array(z.string())
    .describe("Questions the freelancer must answer before sending (e.g. missing email). Empty if none."),
  reasoning_summary: z.string().describe("One or two sentences on how you read the input."),
});

export interface DraftInput {
  text: string;
  file?: { mediaType: string; base64: string };
}

function clientMemory(rows: InvoiceRow[]) {
  const byEmail = new Map<string, { name: string; business: string | null; invoices: number; last: string }>();
  for (const r of rows) {
    if (!r.clientEmail) continue;
    const e = byEmail.get(r.clientEmail);
    if (!e) byEmail.set(r.clientEmail, { name: r.clientName, business: r.clientBusiness, invoices: 1, last: r.invoiceDate });
    else e.invoices++;
  }
  return [...byEmail.entries()].slice(0, 40).map(([email, c]) => ({
    ...c,
    email,
    past_items: store.itemMemory[email]?.slice(-5) ?? [],
  }));
}

export async function draftInvoice(input: DraftInput): Promise<InvoiceDraft> {
  const rows = await listRows().catch(() => [] as InvoiceRow[]);
  const context = {
    today: isoDate(today()),
    default_currency: process.env.DEFAULT_CURRENCY ?? "USD",
    freelancer: process.env.INVOICER_NAME ?? "Alex Rivera",
    known_clients: clientMemory(rows),
  };

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.file) {
    if (input.file.mediaType === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.file.base64 } });
    } else {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: input.file.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data: input.file.base64,
        },
      });
    }
  }
  content.push({
    type: "text",
    text: `<context>\n${JSON.stringify(context, null, 2)}\n</context>\n\n<freelancer_input>\n${input.text || "(see attachment)"}\n</freelancer_input>`,
  });

  const res = await claude().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(DraftSchema) },
    system: `You turn a freelancer's messy notes, client chats, voice transcripts, screenshots or contracts into a PayPal invoice draft.

Rules:
- Bill only for work that the input says was delivered or agreed. Never invent work or prices.
- If the client matches someone in known_clients, reuse their email, business name and past rates when the input says "same as last time" or omits a rate.
- Hourly work: unit HOURS, quantity = hours. Fixed deliverables: unit AMOUNT, quantity 1. Countable items: QUANTITY.
- Due date: use what the input says ("net 15", "by Friday") relative to context.today; default to 14 days after today.
- If something essential is missing (client email, a price), still fill your best guess or null, and add a clear question to missing_info.
- note_to_client: friendly, specific to the work, signed with nothing (PayPal adds the sender).`,
    messages: [{ role: "user", content }],
  });

  if (res.stop_reason === "refusal") throw new Error("The AI declined to process this input.");
  if (!res.parsed_output) throw new Error("The AI response could not be parsed. Try rephrasing the input.");
  return res.parsed_output;
}

// ---------- 2. Collections agent ----------

const AGENT_SYSTEM = `You are Duely's collections assistant for a freelancer. You review their open PayPal invoices and decide who should get a payment reminder today, then draft each reminder.

How to work:
1. Call list_receivables to see open invoices.
2. For clients that look risky (overdue, several invoices, prior reminders), call get_client_history.
3. For each open invoice, call exactly one of propose_reminder or skip_invoice.

Policy:
- Not due yet: skip, unless due within 2 days — then a friendly "heads-up" is fine.
- Never propose a reminder if one was sent in the last 3 days.
- Escalate tone with days overdue and reminders already sent: gentle (1–7 days) → firm (8–21 days or 2+ reminders) → final (22+ days or 3+ reminders).
- Good clients who usually pay get extra warmth. Never threaten, guilt-trip or invent late fees.
- Notes: under 90 words, plain text, mention the invoice number and amount, and say the PayPal payment link is in the email. Sign off with the freelancer's first name.
- Subject: under 80 characters.

The freelancer approves every reminder before it is sent, so explain your reasoning briefly. End with a 2–3 sentence summary of today's collections picture.`;

export async function runCollectionsAgent(): Promise<{ summary: string; proposals: ReminderProposal[] }> {
  const rows = await listRows();
  const open = rows.filter((r) => ["Overdue", "Due soon", "Open"].includes(r.health));
  const runProposals: ReminderProposal[] = [];
  const freelancer = process.env.INVOICER_NAME ?? "Alex Rivera";

  // Drop old pending proposals: this run replaces them.
  store.proposals = store.proposals.filter((p) => p.status !== "pending");

  const listReceivables = betaZodTool({
    name: "list_receivables",
    description: "List the freelancer's open (unpaid) PayPal invoices with amounts, due dates, days overdue and reminder history.",
    inputSchema: z.object({}),
    run: async () =>
      JSON.stringify({
        today: isoDate(today()),
        freelancer,
        invoices: open.map((r) => ({
          invoice_id: r.id,
          number: r.number,
          client: r.clientName,
          client_email: r.clientEmail,
          amount_due: `${r.amountDue.toFixed(2)} ${r.currency}`,
          invoice_date: r.invoiceDate,
          due_date: r.dueDate,
          days_overdue: r.daysOverdue,
          reminders_sent: r.remindersSent,
          last_reminder_at: r.lastReminderAt,
        })),
      }),
  });

  const clientHistory = betaZodTool({
    name: "get_client_history",
    description: "Payment track record for one client across all their PayPal invoices.",
    inputSchema: z.object({ client_email: z.string() }),
    run: async ({ client_email }) => {
      const mine = rows.filter((r) => r.clientEmail.toLowerCase() === client_email.toLowerCase());
      if (mine.length === 0) return "No invoices found for that email.";
      return JSON.stringify({
        total_invoices: mine.length,
        paid: mine.filter((r) => r.health === "Paid").length,
        overdue_now: mine.filter((r) => r.health === "Overdue").length,
        cancelled: mine.filter((r) => r.health === "Cancelled").length,
        lifetime_billed: mine.reduce((s, r) => s + r.total, 0).toFixed(2),
        outstanding: mine.reduce((s, r) => s + r.amountDue, 0).toFixed(2),
        reminders_sent_total: mine.reduce((s, r) => s + r.remindersSent, 0),
      });
    },
  });

  const proposeReminder = betaZodTool({
    name: "propose_reminder",
    description: "Queue a payment reminder for the freelancer to approve. It is NOT sent until they approve it.",
    inputSchema: z.object({
      invoice_id: z.string(),
      urgency: z.enum(["heads-up", "gentle", "firm", "final"]),
      subject: z.string(),
      note: z.string(),
      reasoning: z.string().describe("One sentence on why this reminder and this tone."),
    }),
    run: async (p) => {
      const inv = open.find((r) => r.id === p.invoice_id);
      if (!inv) return `Error: invoice ${p.invoice_id} is not an open invoice.`;
      if (runProposals.some((x) => x.invoiceId === inv.id)) return "Already proposed a reminder for this invoice.";
      const proposal: ReminderProposal = {
        id: newId("rem"),
        invoiceId: inv.id,
        invoiceNumber: inv.number,
        clientName: inv.clientName,
        amountDue: inv.amountDue,
        currency: inv.currency,
        daysOverdue: inv.daysOverdue,
        urgency: p.urgency,
        subject: p.subject.slice(0, 200),
        note: p.note,
        reasoning: p.reasoning,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      runProposals.push(proposal);
      return `Queued for approval (${proposal.id}).`;
    },
  });

  const skipInvoice = betaZodTool({
    name: "skip_invoice",
    description: "Record that an open invoice needs no reminder today, and why.",
    inputSchema: z.object({ invoice_id: z.string(), reasoning: z.string() }),
    run: async () => "Noted.",
  });

  const final = await claude().beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: AGENT_SYSTEM,
    tools: [listReceivables, clientHistory, proposeReminder, skipInvoice],
    messages: [{ role: "user", content: "Run today's collections review." }],
    max_iterations: 20,
  });

  const summary =
    final.stop_reason === "refusal"
      ? "The agent declined this request."
      : final.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();

  store.proposals.unshift(...runProposals);
  logActivity("agent", `Collections agent reviewed ${open.length} open invoices and proposed ${runProposals.length} reminder(s).`);
  return { summary, proposals: runProposals };
}
