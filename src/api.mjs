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

export function publicEndpoint(auth, origins, execution, dispatch) {
  const advertised = capabilities(auth.profile, execution);
  return async (request) => {
    try {
      const path = new URL(request.url).pathname;
      if (request.headers.has("origin") && !origins.includes(request.headers.get("origin"))) {
        throw new Fault("FORBIDDEN", "Origin is not authorized", 403);
      }
      if (request.method === "GET" && path === discovery) return json(advertised);
      if (request.method === "GET" && path === oauthMetadata && auth.metadata) {
        return json(auth.metadata);
      }
      if (!path.startsWith("/v1/")) return notFound();
      return await dispatch(request, await tenantFor(auth, request));
    } catch (error) { return failure(error, auth); }
  };
}

export async function taskEndpoint(request, tenant, service) {
  try {
    const url = new URL(request.url);
    const { method } = request;
    if (url.pathname === "/v1/tasks" && method === "POST") {
      const task = await service.submit(tenant, await readJSON(request));
      return json(task, 202, { location: task.links.self });
    }
    const [prefix, api, tasks, taskId, sub, item, action, ...rest] = url.pathname.split("/");
    if (prefix || api !== "v1" || tasks !== "tasks" || !taskPattern.test(taskId ?? "") || rest.length) return notFound();
    if (!sub && item === undefined && method === "GET") return json(await service.status(tenant, taskId));
    if (sub === "cancel" && item === undefined && method === "POST") return json(await service.cancel(tenant, taskId));
    if (sub === "events" && item === undefined && method === "GET") {
      const cursor = Number(request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Fault("INVALID_MANIFEST", "Invalid event cursor");
      return await service.events(tenant, taskId, cursor, request.signal);
    }
    if (sub === "artifacts" && action === undefined && method === "GET" && (item === undefined || /^[0-7]$/u.test(item))) {
      return await service.artifact(tenant, taskId, item);
    }
    if (sub === "layers" && digestPattern.test(item ?? "")) {
      if (action === "upload" && method === "POST") return json(await service.uploadOffer(tenant, taskId, item));
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
