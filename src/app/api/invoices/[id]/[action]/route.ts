import { handle } from "@/lib/http";
import { cancelInvoice, getInvoice, isMock, mockClientPays, recordExternalPayment, sendReminder, toRow } from "@/lib/paypal";
import { logActivity, recordReminder } from "@/lib/store";

type Ctx = { params: Promise<{ id: string; action: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  return handle(async () => {
    const row = toRow(await getInvoice(id));
    switch (action) {
      case "remind": {
        const body = (await req.json().catch(() => ({}))) as { subject?: string; note?: string };
        const subject = body.subject || `Reminder: invoice #${row.number}`;
        const note = body.note || `Just a friendly reminder that invoice #${row.number} is due. Thank you!`;
        await sendReminder(id, subject, note);
        recordReminder(id);
        logActivity("reminder", `Reminder sent for invoice #${row.number} (${row.clientName}).`);
        break;
      }
      case "mark-paid":
        await recordExternalPayment(id);
        logActivity("payment", `Recorded an outside payment for invoice #${row.number} (${row.clientName}).`);
        break;
      case "cancel":
        await cancelInvoice(id);
        logActivity("invoice", `Cancelled invoice #${row.number}.`);
        break;
      case "simulate-payment":
        if (!isMock) throw new Error("Use the PayPal payer link to pay in sandbox mode.");
        mockClientPays(id);
        logActivity("payment", `${row.clientName} paid invoice #${row.number} through PayPal (demo).`);
        break;
      default:
        throw new Error(`Unknown action ${action}`);
    }
    return { row: toRow(await getInvoice(id)) };
  });
}
