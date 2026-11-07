import { draftInvoice } from "@/lib/ai";
import { handle } from "@/lib/http";
import { logActivity } from "@/lib/store";

const ALLOWED = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];

// Turn messy text and/or an attached screenshot or PDF into an invoice draft.
export async function POST(req: Request) {
  return handle(async () => {
    const form = await req.formData();
    const text = String(form.get("text") ?? "").slice(0, 20_000);
    const file = form.get("file");

    let attachment: { mediaType: string; base64: string } | undefined;
    if (file instanceof File && file.size > 0) {
      if (!ALLOWED.includes(file.type)) throw new Error("Attach a PNG, JPG, WEBP, GIF or PDF.");
      if (file.size > 10 * 1024 * 1024) throw new Error("Attachments must be under 10 MB.");
      attachment = { mediaType: file.type, base64: Buffer.from(await file.arrayBuffer()).toString("base64") };
    }
    if (!text.trim() && !attachment) throw new Error("Describe the work or attach a file.");

    const draft = await draftInvoice({ text, file: attachment });
    logActivity("agent", `AI drafted an invoice for ${draft.client_name} (${draft.items.length} line item(s)).`);
    return { draft };
  });
}
