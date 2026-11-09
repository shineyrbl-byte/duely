import { verifyWebhook } from "@/lib/paypal";
import { loadStore, logActivity, saveStore } from "@/lib/store";

// PayPal webhook receiver. Subscribe your sandbox app to INVOICING.INVOICE.* events
// and set PAYPAL_WEBHOOK_ID. Events are verified with PayPal before we trust them.
export async function POST(req: Request) {
  const event = (await req.json()) as {
    event_type?: string;
    resource?: { invoice?: { detail?: { invoice_number?: string } }; detail?: { invoice_number?: string } };
  };
  let verified = false;
  try {
    verified = await verifyWebhook(req.headers, event);
  } catch (err) {
    console.error("[duely] webhook verification error", err);
  }
  if (!verified) return Response.json({ error: "Webhook not verified" }, { status: 400 });

  const number = event.resource?.invoice?.detail?.invoice_number ?? event.resource?.detail?.invoice_number ?? "?";
  const labels: Record<string, string> = {
    "INVOICING.INVOICE.PAID": `Invoice #${number} was paid through PayPal 🎉`,
    "INVOICING.INVOICE.CANCELLED": `Invoice #${number} was cancelled.`,
    "INVOICING.INVOICE.REFUNDED": `Invoice #${number} was refunded.`,
  };
  await loadStore();
  logActivity(
    event.event_type === "INVOICING.INVOICE.PAID" ? "payment" : "webhook",
    labels[event.event_type ?? ""] ?? `PayPal event ${event.event_type} for invoice #${number}.`,
  );
  await saveStore();
  return Response.json({ ok: true });
}
