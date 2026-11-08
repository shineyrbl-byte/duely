import { connection } from "next/server";
import { aiLabel } from "@/lib/ai";
import { handle } from "@/lib/http";
import { isMock, listRows } from "@/lib/paypal";
import { isoDate, store, today } from "@/lib/store";

// Everything the dashboard needs in one poll.
export async function GET() {
  await connection();
  return handle(async () => ({
    rows: await listRows(),
    proposals: store.proposals,
    activity: store.activity.slice(0, 40),
    today: isoDate(today()),
    clockOffsetDays: store.clockOffsetDays,
    mock: isMock,
    aiEnabled: aiLabel() !== null,
    aiLabel: aiLabel(),
    freelancer: process.env.INVOICER_NAME ?? "Alex Rivera",
  }));
}
