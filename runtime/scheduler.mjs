import { withClient } from "@doco/db";
import { getSingleWorkspaceState, publishDueTimesEdition } from "@doco/host";

const pollMs = Number(process.env.BRAINO_TIMES_POLL_MS ?? 60_000);
if (!Number.isFinite(pollMs) || pollMs < 1_000) {
  throw new Error("BRAINO_TIMES_POLL_MS must be at least 1000 milliseconds.");
}

const baseUrl = (process.env.DOCO_PUBLIC_HOST ?? "http://localhost:3000").replace(/\/+$/, "");
let publishing = false;

async function publish() {
  if (publishing) return;
  publishing = true;
  try {
    const state = await withClient(getSingleWorkspaceState);
    if (!state.initialized) return;
    const edition = await withClient((client) =>
      publishDueTimesEdition(client, {
        workspaceId: state.workspace.id,
        at: new Date(),
        baseUrl,
      }),
    );
    if (edition)
      console.log(`[times] published ${edition.day} with ${edition.stories.length} stories`);
  } catch (error) {
    console.error("[times] publication failed", error);
  } finally {
    publishing = false;
  }
}

await publish();
const interval = setInterval(publish, pollMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(interval);
    process.exit(0);
  });
}
