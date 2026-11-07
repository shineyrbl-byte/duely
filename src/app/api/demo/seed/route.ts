import { handle } from "@/lib/http";
import { addDays, createAndSendInvoice, isoDate, recordExternalPayment } from "@/lib/paypal";
import { logActivity, recordReminder, today } from "@/lib/store";
import type { InvoiceDraft } from "@/lib/types";

export const maxDuration = 120;

interface Seed {
  issuedDaysAgo: number;
  termDays: number;
  paid?: boolean;
  priorReminders?: number;
  draft: Omit<InvoiceDraft, "due_date" | "missing_info" | "reasoning_summary">;
}

const base = { tax_percent: null, discount_percent: null };

const SEEDS: Seed[] = [
  {
    issuedDaysAgo: 45,
    termDays: 14,
    priorReminders: 2,
    draft: {
      ...base,
      client_name: "Marcus Chen",
      client_email: "marcus@brightleaf-demo.com",
      client_business: "Brightleaf Coffee",
      currency: "USD",
      items: [{ name: "Brand identity package", description: "Logo, palette, type system", quantity: 1, unit_price: 1800, unit: "AMOUNT" }],
      note_to_client: "Thanks Marcus — loved building the Brightleaf identity with you.",
    },
  },
  {
    issuedDaysAgo: 24,
    termDays: 14,
    draft: {
      ...base,
      client_name: "Priya Nair",
      client_email: "priya@loomlabs-demo.io",
      client_business: "Loom Labs",
      currency: "USD",
      items: [{ name: "Landing page design", description: "Hero, pricing and FAQ sections", quantity: 18, unit_price: 65, unit: "HOURS" }],
      note_to_client: "Great working with Loom Labs on the new landing page!",
    },
  },
  {
    issuedDaysAgo: 12,
    termDays: 14,
    draft: {
      ...base,
      client_name: "Sofia Alvarez",
      client_email: "sofia@verde-demo.co",
      client_business: "Verde Studio",
      currency: "USD",
      items: [{ name: "Social media templates", description: "12 Instagram post templates", quantity: 12, unit_price: 40, unit: "QUANTITY" }],
      note_to_client: "Hope the templates make posting easier, Sofia!",
    },
  },
  {
    issuedDaysAgo: 30,
    termDays: 7,
    paid: true,
    draft: {
      ...base,
      client_name: "Priya Nair",
      client_email: "priya@loomlabs-demo.io",
      client_business: "Loom Labs",
      currency: "USD",
      items: [{ name: "UX audit", description: "Onboarding flow review", quantity: 1, unit_price: 600, unit: "AMOUNT" }],
      note_to_client: "Thanks for a smooth project.",
    },
  },
  {
    issuedDaysAgo: 3,
    termDays: 30,
    draft: {
      ...base,
      client_name: "Daniel Okafor",
      client_email: "dan@northpeak-demo.com",
      client_business: "Northpeak Outdoors",
      currency: "USD",
      items: [{ name: "Product photography retouching", description: "40 product shots", quantity: 40, unit_price: 12.5, unit: "QUANTITY" }],
      note_to_client: "The new catalogue is going to look great, Daniel.",
    },
  },
];

export async function POST() {
  return handle(async () => {
    const created: string[] = [];
    const notes: string[] = [];
    for (const s of SEEDS) {
      const issued = addDays(today(), -s.issuedDaysAgo);
      const draft: InvoiceDraft = {
        ...s.draft,
        due_date: isoDate(addDays(issued, s.termDays)),
        missing_info: [],
        reasoning_summary: "",
      };
      let inv;
      try {
        inv = await createAndSendInvoice(draft, { invoiceDate: isoDate(issued) });
      } catch {
        // PayPal may reject back-dated invoices; fall back to today and use the demo clock to age them.
        const fresh = { ...draft, due_date: isoDate(addDays(today(), s.termDays)) };
        inv = await createAndSendInvoice(fresh);
        notes.push(`#${inv.detail.invoice_number} could not be back-dated; use the demo clock to age it.`);
      }
      created.push(inv.id);
      if (s.paid) await recordExternalPayment(inv.id, "Paid by bank transfer");
      for (let i = 0; i < (s.priorReminders ?? 0); i++) recordReminder(inv.id);
    }
    logActivity("invoice", `Loaded ${created.length} demo invoices into PayPal.`);
    return { created: created.length, notes };
  });
}
