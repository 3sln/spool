import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withCacheTransaction } from "../client/build-cache.mjs";
import { stateHome, validRunner } from "./mcp-config.mjs";
import { authFetch, authJSON, discoverOAuth, loginOAuth, refreshOAuth, secureURL } from "./oauth.mjs";

const profileName = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const validToken = (value) => typeof value === "string" && /^[!-~]{1,16384}$/u.test(value);

function profileStore(env) {
  const root = resolve(env.SPOOL_AUTH_DIR ?? join(stateHome(env), "spool", "auth"));
  const location = (name) => {
    if (!profileName.test(name ?? "")) throw new Error("Use a profile name with lowercase letters, digits, hyphens, or underscores");
    return join(root, name + ".json");
  };
  async function get(name) {
    const file = await open(location(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (!file) return undefined;
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > 64 * 1024 || (process.platform !== "win32" && (stats.mode & 0o077))) {
        throw new Error("Authentication profile must be a private regular file");
      }
      const data = JSON.parse(await file.readFile("utf8"));
      if (!data || !validToken(data.accessToken) || !["bearer", "oauth"].includes(data.scheme)
        || typeof data.runner !== "string" || validRunner(data.runner) !== data.runner
        || (data.expires !== undefined && !Number.isSafeInteger(data.expires))
        || (data.refreshToken !== undefined && !validToken(data.refreshToken))) {
        throw new Error("Invalid authentication profile");
      }
      return data;
    } finally { await file.close(); }
  }
  return {
    get,
    async list() {
      const names = await readdir(root).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      return names.filter((name) => name.endsWith(".json") && profileName.test(name.slice(0, -5))).sort().map((name) => name.slice(0, -5));
    },
    async write(name, data) {
      const path = location(name);
      const temp = join(root, "." + randomUUID() + ".tmp");
      try {
        await writeFile(temp, JSON.stringify(data) + "\n", { flag: "wx", mode: 0o600 });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    },
    remove: (name) => rm(location(name), { force: true }),
    async lock(name, action) {
      const path = location(name);
      await mkdir(root, { recursive: true, mode: 0o700 });
      return withCacheTransaction(path + ".sqlite", action);
    },
  };
}

function summary(name, { runner, scheme, issuer, expires }) {
  return { profile: name, runner, scheme, ...(issuer && { issuer }), ...(expires && { expires_at: new Date(expires).toISOString() }) };
}

async function inputToken(input) {
  if (input.isTTY) throw new Error("Pipe the token to --token-stdin, or supply SPOOL_TOKEN");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > 16386) throw new Error("Bearer token exceeds the size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8").replace(/\r?\n$/u, "");
}

async function checkCredential(runner, accessToken) {
  const headers = { authorization: "Bearer " + accessToken };
  const check = await authFetch(new URL("/v1/auth/check", runner), { headers });
  if (check.status === 204) return;
  await check.body?.cancel();
  if (check.status === 404) {
    // Older Spool runners authenticate all /v1 task lookups before checking the task ID.
    const fallback = await authFetch(new URL("/v1/tasks/" + randomUUID(), runner), { headers });
    if (fallback.status === 404 && (await authJSON(fallback).catch(() => null))?.error === "NOT_FOUND") return;
    await fallback.body?.cancel().catch(() => {});
    throw new Error(`Runner rejected the credential (HTTP ${fallback.status})`);
  }
  throw new Error(`Runner rejected the credential (HTTP ${check.status})`);
}

export async function authCommand(options, env, { input = process.stdin, show = (message) => console.error(message) } = {}) {
  const store = profileStore(env);
  const name = options.profile ?? env.SPOOL_PROFILE;
  if (options.action === "list") {
    const profiles = await Promise.all((await store.list()).map(async (name) => {
      const profile = await store.get(name);
      return profile && summary(name, profile);
    }));
    return profiles.filter(Boolean);
  }
  if (options.action === "logout") {
    await store.lock(name, () => store.remove(name));
    return { profile: name, removed: true };
  }
  if (!profileName.test(name ?? "")) throw new Error("Select a profile with --profile NAME");
  const runner = validRunner(options.runner ?? env.SPOOL_URL);
  if (!runner) throw new Error("Set --runner to the runner origin");
  secureURL(runner, true);
  const response = await authFetch(new URL("/.well-known/portable-task-runner", runner));
  if (!response.ok) throw new Error(`Runner discovery returned HTTP ${response.status}`);
  const discovery = await authJSON(response);
  const scheme = options.scheme ?? (discovery.auth === "oauth-bearer" ? "oauth"
    : discovery.auth === "bearer-token" ? "bearer" : undefined);
  let profile;
  if (scheme === "bearer") {
    const accessToken = options["token-stdin"] ? await inputToken(input) : env.SPOOL_TOKEN;
    if (!validToken(accessToken)) throw new Error("Supply a bearer token with --token-stdin or SPOOL_TOKEN");
    profile = { runner, scheme, accessToken };
  } else if (scheme === "oauth") {
    if (options["token-stdin"]) throw new Error("Use --token-stdin with bearer authentication");
    const oauth = await discoverOAuth(runner, { issuer: options.issuer,
      clientId: options["client-id"] ?? env.SPOOL_OAUTH_CLIENT_ID, scope: options.scope });
    profile = { runner, scheme, ...await loginOAuth(oauth, options["redirect-port"], show) };
  } else {
    throw new Error("Select a supported scheme with --scheme bearer or --scheme oauth");
  }
  await checkCredential(runner, profile.accessToken);
  await store.lock(name, () => store.write(name, profile));
  return summary(name, profile);
}

export async function runnerConnection(options, env) {
  const name = options.profile ?? env.SPOOL_PROFILE;
  const runner = validRunner(options.runner ?? env.SPOOL_URL);
  if (!name) return { url: runner ?? "http://127.0.0.1:8787", headers: () => env.SPOOL_TOKEN
    ? { authorization: "Bearer " + env.SPOOL_TOKEN } : {} };
  const store = profileStore(env);
  const missing = () => new Error(`Run spool-mcp auth login for profile "${name}"`);
  const profile = await store.get(name);
  if (!profile) throw missing();
  if (runner && runner !== profile.runner) throw new Error("Profile belongs to a different runner origin");
  secureURL(profile.runner, true);

  async function current() {
    const result = await store.get(name);
    if (!result) throw missing();
    if (result.runner !== profile.runner) throw new Error("Profile runner changed. Restart the CLI to use its new origin.");
    return result;
  }
  return {
    url: profile.runner,
    async headers() {
      let auth = await current();
      if (auth.scheme === "oauth" && auth.expires && auth.expires <= Date.now() + 30_000 && auth.refreshToken) {
        auth = await store.lock(name, async () => {
          const fresh = await current();
          if (fresh.scheme !== "oauth" || !fresh.expires || fresh.expires > Date.now() + 30_000 || !fresh.refreshToken) return fresh;
          const updated = { ...fresh, ...await refreshOAuth(fresh) };
          await store.write(name, updated);
          return updated;
        });
      }
      if (auth.expires && auth.expires <= Date.now()) throw missing();
      return { authorization: "Bearer " + auth.accessToken };
    },
  };
}
