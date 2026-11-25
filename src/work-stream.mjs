const encoder = new TextEncoder();

export async function* workChunks(work, layerSource) {
  yield encoder.encode(JSON.stringify(work) + "\n");
  for (const [index, layer] of work.manifest.environment.layers.entries()) {
    const source = await layerSource(index);
    if (!source) throw new Error("Execution layer disappeared");
    if (source instanceof Uint8Array) {
      yield source;
      continue;
    }
    const reader = source.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > layer.size) throw new Error("Execution layer exceeded its declared size");
        yield value;
      }
      if (received !== layer.size) throw new Error("Execution layer ended before its declared size");
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

export function workStream(work, layerSource) {
  const chunks = workChunks(work, layerSource);
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() { return chunks.return(); },
  });
}
