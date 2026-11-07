import { handle } from "@/lib/http";
import { isoDate, logActivity, store, today } from "@/lib/store";

// Demo clock: shift "today" forward so overdue flows can be shown without waiting weeks.
export async function POST(req: Request) {
  return handle(async () => {
    const { offsetDays } = (await req.json()) as { offsetDays: number };
    store.clockOffsetDays = Math.max(0, Math.min(120, Math.round(Number(offsetDays) || 0)));
    logActivity("invoice", `Demo clock set to ${isoDate(today())} (+${store.clockOffsetDays} days).`);
    return { clockOffsetDays: store.clockOffsetDays };
  });
}
