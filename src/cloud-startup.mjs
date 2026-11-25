const guestOrigin = "http://spool.internal";

function retryableStart(error) {
  return /no container instance that can be provided|requesting too many containers per second/iu.test(error.message);
}

// A readiness probe can fail before Cloudflare settles the start attempt.
export async function waitForGuest(container, deadline, cancelled, {
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let attempt;
  let retryDelay = 1000;
  let lastError;
  while (Date.now() < deadline && !await cancelled()) {
    if (!attempt) {
      attempt = {};
      try {
        if (!container.running) container.start({ enableInternet: false });
        const current = attempt;
        container.monitor().then(
          () => { current.error = new Error("Guest exited during startup"); },
          (error) => { current.error = error; },
        );
      } catch (error) {
        attempt.error = error;
      }
    }
    if (attempt.error) {
      lastError = attempt.error;
      if (!retryableStart(lastError)) throw lastError;
      attempt = undefined;
      await wait(Math.min(retryDelay, Math.max(0, deadline - Date.now())));
      retryDelay = Math.min(5000, retryDelay * 2);
      continue;
    }

    try {
      const port = container.getTcpPort(8080);
      const health = await port.fetch(`${guestOrigin}/healthz`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
      });
      await health.body?.cancel();
      if (health.status === 204 && !attempt.error && Date.now() < deadline && !await cancelled()) return port;
      if (health.status !== 204) lastError = new Error(`Guest health returned HTTP ${health.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Guest stopped or did not become ready before its startup deadline", { cause: lastError });
}
