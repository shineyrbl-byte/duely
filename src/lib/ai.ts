// AI features, with two interchangeable providers:
//   - Google Gemini (free tier) when GEMINI_API_KEY is set
//   - Anthropic Claude when ANTHROPIC_API_KEY is set
// Set AI_PROVIDER=gemini|anthropic to force one.
//
//  1. draftInvoice – turn a messy chat / voice note / screenshot / PDF into a structured invoice draft.
//  2. runCollectionsAgent – an agent that reviews open PayPal invoices and *proposes* reminders.
//     Nothing is sent to a client until the freelancer approves it in the UI.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ApiError, GoogleGenAI, type Content, type GenerateContentParameters, type Part } from "@google/genai";
import { z } from "zod";
import { listRows } from "./paypal";
import { isoDate, logActivity, newId, store, today } from "./store";
import type { InvoiceDraft, InvoiceRow, ReminderProposal } from "./types";

// ---------- Provider selection ----------

export type AiProvider = "gemini" | "anthropic";

export function aiProvider(): AiProvider | null {
  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced === "gemini" || forced === "anthropic") return forced;
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  return null;
}

export function aiLabel(): string | null {
  const p = aiProvider();
  if (p === "gemini") return `Gemini (${GEMINI_MODEL})`;
  if (p === "anthropic") return `Claude (${CLAUDE_MODEL})`;
  return null;
}

function requireProvider(): AiProvider {
  const p = aiProvider();
  if (!p) throw new Error("No AI key set — add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY to .env.local.");
  return p;
}

const CLAUDE_MODEL = "claude-opus-5-5";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
// Free-tier models get overloaded at times; fall back through these in order.
const GEMINI_FALLBACKS = [GEMINI_MODEL, "gemini-3.8-flash", "gemini-flash-latest"].filter((m, i, a) => a.indexOf(m) === i);

// If a Claude request is declined by a safety classifier, the API retries it on a fallback model.
const CLAUDE_FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

let anthropic: Anthropic | null = null;
const claude = () => (anthropic ??= new Anthropic());

let gemini: GoogleGenAI | null = null;
// 45s per call, so an overloaded model fails over instead of hanging the request.
const google = () => (gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 45_000 } }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (err: unknown) =>
  (err instanceof ApiError && [404, 429, 500, 503].includes(err.status)) ||
  (err instanceof Error && /abort|timeout|timed out|fetch failed/i.test(err.message));

/**
 * Calls Gemini, retrying briefly and then moving to the next fallback model when
 * Google reports overload or rate limits. Pass `pinned` to stay on one model
 * (needed mid-agent-loop, where thought signatures are tied to the model).
 */
async function geminiGenerate(params: Omit<GenerateContentParameters, "model">, pinned?: string) {
  const models = pinned ? [pinned] : GEMINI_FALLBACKS;
  let lastErr: unknown;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { model, res: await google().models.generateContent({ ...params, model }) };
      } catch (err) {
        if (!isTransient(err)) throw err;
        lastErr = err;
        // Only quick failures (busy / rate limited) are worth retrying on the same model.
        const quick = err instanceof ApiError && [429, 503].includes(err.status);
        if (!quick) break;
        await sleep(800 * (attempt + 1));
      }
    }
  }
  const status = lastErr instanceof ApiError ? lastErr.status : 0;
  throw new Error(
    status === 429
      ? "Gemini free-tier limit reached. Wait a minute and try again."
      : "Gemini is busy right now. Please try again in a moment.",
  );
}

/** Zod -> plain JSON Schema for Gemini (drop the $schema marker it doesn't need). */
function jsonSchema(schema: z.ZodType) {
  const out = z.toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  return out;
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

const DRAFT_SYSTEM = `You turn a freelancer's messy notes, client chats, voice transcripts, screenshots or contracts into a PayPal invoice draft.

Rules:
- Bill only for work that the input says was delivered or agreed. Never invent work or prices.
- If the client matches someone in known_clients, reuse their email, business name and past rates when the input says "same as last time" or omits a rate.
- Hourly work: unit HOURS, quantity = hours. Fixed deliverables: unit AMOUNT, quantity 1. Countable items: QUANTITY.
- Due date: use what the input says ("net 15", "by Friday") relative to context.today; default to 14 days after today.
- If something essential is missing (client email, a price), still fill your best guess or null, and add a clear question to missing_info.
- note_to_client: friendly, specific to the work, signed with nothing (PayPal adds the sender).`;

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
  const provider = requireProvider();
  const rows = await listRows().catch(() => [] as InvoiceRow[]);
  const context = {
    today: isoDate(today()),
    default_currency: process.env.DEFAULT_CURRENCY ?? "USD",
    freelancer: process.env.INVOICER_NAME ?? "Alex Rivera",
    known_clients: clientMemory(rows),
  };
  const prompt = `<context>\n${JSON.stringify(context, null, 2)}\n</context>\n\n<freelancer_input>\n${input.text || "(see attachment)"}\n</freelancer_input>`;
  return provider === "gemini" ? draftWithGemini(prompt, input.file) : draftWithClaude(prompt, input.file);
}

async function draftWithGemini(prompt: string, file?: DraftInput["file"]): Promise<InvoiceDraft> {
  const parts: Part[] = [];
  if (file) parts.push({ inlineData: { mimeType: file.mediaType, data: file.base64 } });
  parts.push({ text: prompt });

  const { res } = await geminiGenerate({
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction: DRAFT_SYSTEM,
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchema(DraftSchema),
    },
  });
  if (!res.text) throw new Error("The AI returned no draft. Try rephrasing the input.");
  const parsed = DraftSchema.safeParse(JSON.parse(res.text));
  if (!parsed.success) throw new Error("The AI response could not be parsed. Try rephrasing the input.");
  return parsed.data;
}

async function draftWithClaude(prompt: string, file?: DraftInput["file"]): Promise<InvoiceDraft> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (file?.mediaType === "application/pdf") {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } });
  } else if (file) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: file.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data: file.base64,
      },
    });
  }
  content.push({ type: "text", text: prompt });

  const res = await claude().beta.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    ...CLAUDE_FALLBACK,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(DraftSchema) },
    system: DRAFT_SYSTEM,
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

The freelancer approves every reminder before it is sent, so keep each tool call's reasoning brief. Your final reply is shown in a small panel: write only a 2–3 sentence plain-text summary of today's collections picture (no markdown, headings, bullets or per-invoice lists — the proposals are shown separately).`;

/** A provider-neutral tool: one definition, wrapped for Claude or Gemini. */
interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<string>;
}
const tool = <S extends z.ZodType>(t: AgentTool<S>) => t as unknown as AgentTool;

function buildAgentTools(rows: InvoiceRow[], open: InvoiceRow[], runProposals: ReminderProposal[]): AgentTool[] {
  const freelancer = process.env.INVOICER_NAME ?? "Alex Rivera";
  return [
    tool({
      name: "list_receivables",
      description:
        "List the freelancer's open (unpaid) PayPal invoices with amounts, due dates, days overdue and reminder history.",
      schema: z.object({}),
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
    }),
    tool({
      name: "get_client_history",
      description: "Payment track record for one client across all their PayPal invoices.",
      schema: z.object({ client_email: z.string() }),
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
    }),
    tool({
      name: "propose_reminder",
      description: "Queue a payment reminder for the freelancer to approve. It is NOT sent until they approve it.",
      schema: z.object({
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
    }),
    tool({
      name: "skip_invoice",
      description: "Record that an open invoice needs no reminder today, and why.",
      schema: z.object({ invoice_id: z.string(), reasoning: z.string() }),
      run: async () => "Noted.",
    }),
  ];
}

async function runTool(tools: AgentTool[], name: string, args: unknown): Promise<string> {
  const t = tools.find((x) => x.name === name);
  if (!t) return `Error: unknown tool ${name}.`;
  const parsed = t.schema.safeParse(args ?? {});
  if (!parsed.success) return `Error: invalid input for ${name}: ${parsed.error.message}`;
  return t.run(parsed.data);
}

async function agentWithGemini(tools: AgentTool[]): Promise<string> {
  const contents: Content[] = [{ role: "user", parts: [{ text: "Run today's collections review." }] }];
  const config = {
    systemInstruction: AGENT_SYSTEM,
    tools: [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: jsonSchema(t.schema),
        })),
      },
    ],
  };

  let model: string | undefined;
  for (let turn = 0; turn < 20; turn++) {
    const out = await geminiGenerate({ contents, config }, model);
    model = out.model;
    const res = out.res;
    const calls = res.functionCalls ?? [];
    const modelTurn = res.candidates?.[0]?.content;
    if (calls.length === 0) return res.text?.trim() ?? "";

    // Send the model's turn back unchanged: Gemini needs its thought signatures preserved.
    if (modelTurn) contents.push(modelTurn);
    const responses: Part[] = [];
    for (const call of calls) {
      const output = await runTool(tools, call.name ?? "", call.args);
      responses.push({ functionResponse: { id: call.id, name: call.name, response: { output } } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return "The agent stopped after reaching its step limit.";
}

async function agentWithClaude(tools: AgentTool[]): Promise<string> {
  const final = await claude().beta.messages.toolRunner({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    ...CLAUDE_FALLBACK,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: AGENT_SYSTEM,
    tools: tools.map((t) =>
      betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema, run: (input) => t.run(input) }),
    ),
    messages: [{ role: "user", content: "Run today's collections review." }],
    max_iterations: 20,
  });
  if (final.stop_reason === "refusal") return "The agent declined this request.";
  return final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function runCollectionsAgent(): Promise<{ summary: string; proposals: ReminderProposal[] }> {
  const provider = requireProvider();
  const rows = await listRows();
  const open = rows.filter((r) => ["Overdue", "Due soon", "Open"].includes(r.health));
  const runProposals: ReminderProposal[] = [];
  const tools = buildAgentTools(rows, open, runProposals);

  // This run replaces any proposals still waiting for approval.
  store.proposals = store.proposals.filter((p) => p.status !== "pending");

  const summary = provider === "gemini" ? await agentWithGemini(tools) : await agentWithClaude(tools);

  store.proposals.unshift(...runProposals);
  logActivity(
    "agent",
    `Collections agent (${aiLabel()}) reviewed ${open.length} open invoices and proposed ${runProposals.length} reminder(s).`,
  );
  return { summary, proposals: runProposals };
}
