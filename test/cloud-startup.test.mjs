import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForGuest } from "../src/cloud-startup.mjs";

function fixture(probe) {
  let starts = 0;
  let probes = 0;
  let monitor;
  const port = {
    fetch() {
      probes++;
      return probe(probes, monitor);
    },
  };
  return {
    port,
    get starts() { return starts; },
    container: {
      running: false,
      start(options) {
        assert.deepEqual(options, { enableInternet: false });
        starts++;
        monitor = Promise.withResolvers();
      },
      monitor: () => monitor.promise,
      getTcpPort: () => port,
    },
  };
}

test("readiness errors never restart an unsettled Cloudflare container", async () => {
  const guest = fixture((probes) => {
    if (probes < 3) throw new Error("Port is not listening yet");
    return new Response(null, { status: 204 });
  });
  const port = await waitForGuest(guest.container, Date.now() + 2000, () => false, { wait: async () => {} });
  assert.equal(port, guest.port);
  assert.equal(guest.starts, 1);
});

test("a monitored allocation failure allows a backed-off retry", async () => {
  const guest = fixture((probes, monitor) => {
    if (probes === 1) {
      monitor.reject(new Error("There is no container instance that can be provided to this Durable Object"));
      throw new Error("Start pending");
    }
    return new Response(null, { status: 204 });
  });
  const waits = [];
  await waitForGuest(guest.container, Date.now() + 2000, () => false, { wait: async (ms) => waits.push(ms) });
  assert.equal(guest.starts, 2);
  assert.ok(waits.includes(1000));
});

test("a guest process exit stays a distinct startup failure", async () => {
  const guest = fixture((_probes, monitor) => {
    monitor.reject(new Error("Container exited with unexpected exit code: 1"));
    throw new Error("Port is not listening");
  });
  await assert.rejects(waitForGuest(guest.container, Date.now() + 2000, () => false, { wait: async () => {} }),
    /unexpected exit code/u);
  assert.equal(guest.starts, 1);
});
