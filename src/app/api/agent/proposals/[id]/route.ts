import { handle } from "@/lib/http";
import { sendReminder } from "@/lib/paypal";
import { logActivity, recordReminder, store } from "@/lib/store";

type Ctx = { params: Promise<{ id: string }> };

// Approve (optionally with edits) or dismiss a reminder the agent proposed.
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return handle(async () => {
    const p = store.proposals.find((x) => x.id === id);
    if (!p) throw new Error("Proposal not found.");
    if (p.status !== "pending") throw new Error(`Proposal already ${p.status}.`);
    const body = (await req.json()) as { action: "approve" | "dismiss"; subject?: string; note?: string };

    if (body.action === "dismiss") {
      p.status = "dismissed";
      return { proposal: p };
    }
    if (body.subject) p.subject = body.subject;
    if (body.note) p.note = body.note;
    try {
      await sendReminder(p.invoiceId, p.subject, p.note);
      p.status = "sent";
      recordReminder(p.invoiceId);
      logActivity("reminder", `Approved ${p.urgency} reminder sent via PayPal for invoice #${p.invoiceNumber} (${p.clientName}).`);
    } catch (err) {
      p.status = "failed";
      p.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    return { proposal: p };
  });
}
