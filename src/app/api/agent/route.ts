import { runCollectionsAgent } from "@/lib/ai";
import { handle } from "@/lib/http";

export const maxDuration = 120;

// Run the collections agent. It only queues proposals; it never emails clients itself.
export async function POST() {
  return handle(() => runCollectionsAgent());
}
