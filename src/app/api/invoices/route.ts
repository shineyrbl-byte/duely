import { DraftSchema } from "@/lib/ai";
import { handle } from "@/lib/http";
import { createAndSendInvoice, draftTotals, toRow } from "@/lib/paypal";
import { logActivity, store } from "@/lib/store";

// Create the invoice in PayPal from a reviewed draft and send it to the client.
export async function POST(req: Request) {
  return handle(async () => {
    const draft = DraftSchema.parse(await req.json());
    if (!draft.client_email) throw new Error("Add the client's email before sending.");
    if (draft.items.length === 0) throw new Error("Add at least one line item.");

    const inv = await createAndSendInvoice(draft);
    const row = toRow(inv);

    store.itemMemory[draft.client_email] = [
      ...(store.itemMemory[draft.client_email] ?? []),
      ...draft.items.map((i) => ({ name: i.name, unit_price: i.unit_price, unit: i.unit, currency: draft.currency })),
    ].slice(-20);

    const { total } = draftTotals(draft);
    logActivity("invoice", `Sent invoice #${row.number} to ${row.clientName} for ${total.toFixed(2)} ${draft.currency} via PayPal.`);
    return { row };
  });
}
