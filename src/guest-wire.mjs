import { readJSON } from "./contract.mjs";

export async function consumeGuest(response, onLog) {
  if (response.headers?.get("content-type")?.split(";")[0] !== "application/x-ndjson") {
    return readJSON(response, 2 * 1024 ** 2);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream("utf-8", { fatal: true })).getReader();
  let pending = "";
  let result;
  let complete = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        if (end > 2 * 1024 ** 2 || complete) throw new Error("Unexpected guest frame");
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type === "log") await onLog?.({ channel: frame.channel, text: frame.text });
        else if (frame.type === "result") {
          result = frame.result;
          complete = true;
        } else throw new Error("Unexpected guest frame");
      }
      if (pending.length > 2 * 1024 ** 2) throw new Error("Guest frame exceeds limit");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!complete || pending.length) throw new Error("Guest response ended without a complete result");
  return result;
}
