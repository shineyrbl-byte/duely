import { PayPalError } from "./paypal";
import { logActivity } from "./store";

/** Wraps a route handler so errors come back as JSON the UI can show. */
export async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    const data = await fn();
    return Response.json(data ?? { ok: true });
  } catch (err) {
    const status = err instanceof PayPalError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[duely]", message, err instanceof PayPalError ? JSON.stringify(err.details) : "");
    logActivity("error", message);
    return Response.json({ error: message }, { status: status >= 400 && status < 600 ? status : 500 });
  }
}
