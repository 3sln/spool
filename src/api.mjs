import { capabilities, digestPattern, Fault, json, readJSON, taskPattern } from "./contract.mjs";
import { tenantFor } from "./auth.mjs";

const discovery = "/.well-known/portable-task-runner";
const oauthMetadata = "/.well-known/oauth-protected-resource";

function notFound() { throw new Fault("NOT_FOUND", "Route not found", 404); }

function failure(error, auth) {
  if (!(error instanceof Fault)) {
    console.error("Request failed", error.message);
    return json({ error: "INTERNAL", message: "Internal error" }, 500);
  }
  const headers = error.status === 401 && auth?.challenge ? { "www-authenticate": auth.challenge } : {};
  return json({ error: error.code, message: error.message }, error.status, headers);
}

export function publicEndpoint(auth, origins, execution, dispatch, limits) {
  const advertised = capabilities(auth.profile, execution, limits);
  const methods = ["GET", "POST", "PUT"];
  const allowedHeaders = "authorization, content-type, last-event-id, cf-access-client-id, cf-access-client-secret";
  const allowedOrigins = new Set(origins.map((origin) => origin.trim()).filter(Boolean));
  async function route(request, origin) {
    const path = new URL(request.url).pathname;
    if (path !== discovery && path !== oauthMetadata && !path.startsWith("/v1/")) return notFound();
    if (origin && request.method === "OPTIONS") {
      if (!methods.includes(request.headers.get("access-control-request-method"))) {
        throw new Fault("FORBIDDEN", "Requested method is not authorized", 403);
      }
      return new Response(null, {
        status: 204,
        headers: { "access-control-allow-methods": methods.join(", "), "access-control-allow-headers": allowedHeaders },
      });
    }
    if (request.method === "GET" && path === discovery) return json(advertised);
    if (request.method === "GET" && path === oauthMetadata && auth.metadata) return json(auth.metadata);
    if (!path.startsWith("/v1/")) return notFound();
    const tenant = await tenantFor(auth, request);
    if (request.method === "GET" && path === "/v1/auth/check") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    return dispatch(request, tenant);
  }
  return async (request) => {
    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.has(origin)) {
      return failure(new Fault("FORBIDDEN", "Origin is not authorized", 403), auth);
    }
    let response;
    try { response = await route(request, origin); }
    catch (error) { response = failure(error, auth); }
    if (allowedOrigins.size === 0) return response;
    const headers = new Headers(response.headers);
    headers.append("vary", "Origin");
    if (origin !== null) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-expose-headers", "location, www-authenticate");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

export async function taskEndpoint(request, tenant, service) {
  try {
    const url = new URL(request.url);
    const { method } = request;
    if (url.pathname === "/v1/tasks" && method === "POST") {
      const task = await service.submit(tenant, await readJSON(request, service.limits?.max_manifest_bytes), { signal: request.signal });
      return json(task, 202, { location: task.links.self });
    }
    const [prefix, api, tasks, taskId, sub, item, action, ...rest] = url.pathname.split("/");
    if (prefix || api !== "v1" || tasks !== "tasks" || !taskPattern.test(taskId ?? "") || rest.length) return notFound();
    if (!sub && item === undefined && method === "GET") return json(await service.status(tenant, taskId));
    if (sub === "cancel" && item === undefined && method === "POST") return json(await service.cancel(tenant, taskId));
    if (sub === "extend" && item === undefined && method === "POST") {
      return json(await service.extend(tenant, taskId, (await readJSON(request, 1024))?.task_timeout_s));
    }
    if (sub === "events" && item === undefined && method === "GET" && url.searchParams.has("limit")) {
      return json(await service.eventPage(tenant, taskId, Number(url.searchParams.get("cursor") ?? 0),
        Number(url.searchParams.get("limit"))));
    }
    if (sub === "events" && item === undefined && method === "GET") {
      const cursor = Number(request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Fault("INVALID_MANIFEST", "Invalid event cursor");
      return await service.events(tenant, taskId, cursor, request.signal);
    }
    if (sub === "artifacts" && method === "GET") {
      if (action === undefined && (item === undefined || /^[0-7]$/u.test(item))) return await service.artifact(tenant, taskId, item);
      if (action === "download" && /^[0-7]$/u.test(item)) return await service.artifact(tenant, taskId, item, { plan: true });
    }
    if (sub === "layers" && digestPattern.test(item ?? "")) {
      if (action === "upload" && method === "POST") return json(await service.uploadOffer(tenant, taskId, item));
      if (action === "pull" && method === "POST") {
        return json(await service.pullLayer(tenant, taskId, item, await readJSON(request, 32 * 1024), request.signal));
      }
      if (action === "complete" && method === "POST") {
        return json(await service.completeUpload(tenant, taskId, item, (await readJSON(request, 64 * 1024))?.parts));
      }
      if (action === "retain" && method === "POST") {
        return json(await service.retain(tenant, taskId, item, (await readJSON(request, 1024))?.ttl_s));
      }
      if (action === undefined && method === "PUT") {
        return json(await service.upload(tenant, taskId, item, url.searchParams.get("capability"), request));
      }
    }
    return notFound();
  } catch (error) { return failure(error); }
}
