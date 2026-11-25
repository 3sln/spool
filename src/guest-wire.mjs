import { readJSON } from "./contract.mjs";

async function* guestFrames(body) {
  const reader = body.pipeThrough(new TextDecoderStream("utf-8", { fatal: true })).getReader();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        if (end > 2 * 1024 ** 2) throw new Error("Guest frame exceeds limit");
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        yield frame;
      }
      if (pending.length > 2 * 1024 ** 2) throw new Error("Guest frame exceeds limit");
    }
    if (pending.length) throw new Error("Guest produced an incomplete frame");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function consumeGuest(response, onLog, onArtifact) {
  if (response.headers?.get("content-type")?.split(";")[0] !== "application/x-ndjson") {
    return readJSON(response, 2 * 1024 ** 2);
  }
  const frames = guestFrames(response.body);
  let result;
  try {
    for (;;) {
      const { value: frame, done } = await frames.next();
      if (done) break;
      if (result) throw new Error("Unexpected guest frame after result");
      if (frame.type === "log") await onLog?.({ channel: frame.channel, text: frame.text });
      else if (frame.type === "result") result = frame.result;
      else if (frame.type === "artifact") {
        let remaining = frame.artifact?.size;
        if (!onArtifact || !Number.isSafeInteger(remaining) || remaining < 0) throw new Error("Unexpected guest artifact");
        const stream = new ReadableStream({
          async pull(controller) {
            if (!remaining) return controller.close();
            const { value } = await frames.next();
            if (value?.type !== "artifact.chunk" || typeof value.body !== "string" || value.body.length > 90_000) {
              throw new Error("Invalid guest artifact chunk");
            }
            const chunk = Uint8Array.from(atob(value.body), (byte) => byte.charCodeAt(0));
            if (!chunk.length || chunk.length > remaining) throw new Error("Invalid guest artifact length");
            remaining -= chunk.length;
            controller.enqueue(chunk);
            if (!remaining) controller.close();
          },
        });
        await onArtifact(frame.artifact, stream);
        if (remaining) throw new Error("Guest artifact was not consumed");
      } else throw new Error("Unexpected guest frame");
    }
  } finally {
    await frames.return();
  }
  if (!result) throw new Error("Guest response ended without a result");
  return result;
}
