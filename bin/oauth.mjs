import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const resourceMetadata = "/.well-known/oauth-protected-resource";
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";

export function secureURL(input, allowLocal = false) {
  const url = new URL(input);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && allowLocal && url.protocol === "http:"))
    || url.username || url.password || url.hash) throw new Error("Use HTTPS for authentication endpoints");
  return url;
}

export async function authFetch(url, options = {}) {
  return fetch(url, { ...options, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15_000) });
}

export async function authJSON(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("Authentication response exceeded the size limit");
    chunks.push(chunk);
  }
  const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Expected an authentication response object");
  return result;
}

export async function discoverOAuth(runner, options) {
  const allowLocal = new URL(runner).protocol === "http:";
  const protectedResource = await authFetch(new URL(resourceMetadata, runner));
  if (!protectedResource.ok) throw new Error(`Runner OAuth discovery returned HTTP ${protectedResource.status}`);
  const resource = await authJSON(protectedResource);
  if (resource.resource !== runner || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.length) {
    throw new Error("Invalid runner OAuth resource metadata");
  }
  if (resource.authorization_servers.length > 1 && !options.issuer) throw new Error("Select an advertised OAuth issuer with --issuer");
  const issuer = options.issuer ?? resource.authorization_servers[0];
  if (!resource.authorization_servers.includes(issuer)) throw new Error("The runner does not advertise the selected OAuth issuer");
  const issuerURL = secureURL(issuer, allowLocal);
  if (issuerURL.search) throw new Error("OAuth issuer must not contain a query string");
  const path = issuerURL.pathname.replace(/\/$/u, "");
  let response = await authFetch(new URL("/.well-known/oauth-authorization-server" + path, issuerURL));
  if (response.status === 404) {
    await response.body?.cancel();
    response = await authFetch(new URL(path + "/.well-known/openid-configuration", issuerURL));
  }
  if (!response.ok) throw new Error(`Issuer discovery returned HTTP ${response.status}`);
  const metadata = await authJSON(response);
  if (metadata.issuer !== issuer) throw new Error("OAuth issuer metadata does not match the runner’s issuer");
  const clientId = options.clientId;
  if (!clientId) throw new Error("Set --client-id to the registered public OAuth client ID");
  const authMethods = metadata.token_endpoint_auth_methods_supported;
  if (authMethods !== undefined && (!Array.isArray(authMethods) || !authMethods.includes("none"))) {
    throw new Error("The issuer must support public OAuth clients");
  }
  const endpoint = (key) => metadata[key] === undefined ? undefined : secureURL(metadata[key], allowLocal).href;
  const tokenEndpoint = endpoint("token_endpoint");
  if (!tokenEndpoint) throw new Error("Issuer metadata does not advertise a token endpoint");
  const scope = options.scope ?? (Array.isArray(resource.scopes_supported) ? resource.scopes_supported.join(" ") : "");
  return { issuer, clientId, resource: runner, tokenEndpoint, scope,
    deviceEndpoint: endpoint("device_authorization_endpoint"), authorizationEndpoint: endpoint("authorization_endpoint"),
    pkce: Array.isArray(metadata.code_challenge_methods_supported) && metadata.code_challenge_methods_supported.includes("S256"),
  };
}

async function post(endpoint, parameters) {
  const response = await authFetch(endpoint, { method: "POST", body: new URLSearchParams(parameters) });
  let value;
  try { value = await authJSON(response); }
  catch { throw new Error(`OAuth endpoint returned an unreadable response (HTTP ${response.status})`); }
  if (!response.ok && typeof value.error !== "string") throw new Error(`OAuth endpoint returned HTTP ${response.status}`);
  if (!response.ok || value.error) {
    const code = /^[a-z_]{1,40}$/u.test(value.error) ? value.error : "invalid_response";
    throw Object.assign(new Error(`OAuth request failed (${code})`), { oauthCode: code });
  }
  return value;
}

function token(value, previous) {
  const valid = (value) => typeof value === "string" && /^[!-~]{1,16384}$/u.test(value);
  if (!valid(value.access_token) || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"
    || (value.refresh_token !== undefined && !valid(value.refresh_token))) {
    throw new Error("Expected a bearer access token from the issuer");
  }
  let expires;
  if (value.expires_in !== undefined) {
    expires = Date.now() + value.expires_in * 1000;
    if (!Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || !Number.isSafeInteger(expires)) throw new Error("Invalid token expiry");
  }
  return { accessToken: value.access_token, refreshToken: value.refresh_token ?? previous, expires };
}

function params(config) {
  return { client_id: config.clientId, resource: config.resource, ...(config.scope && { scope: config.scope }) };
}

async function deviceLogin(config, show) {
  const code = await post(config.deviceEndpoint, params(config));
  const allowLocal = new URL(config.resource).protocol === "http:";
  const url = secureURL(code.verification_uri_complete ?? code.verification_uri, allowLocal);
  if (typeof code.device_code !== "string" || typeof code.user_code !== "string" || !/^[ -~]{1,64}$/u.test(code.user_code)
    || !Number.isSafeInteger(code.expires_in) || code.expires_in < 1 || code.expires_in > 3600) throw new Error("Invalid device authorization response");
  let interval = code.interval ?? 5;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60) throw new Error("Invalid device polling interval");
  show(`Open ${url.href} and confirm code ${code.user_code}`);
  const expires = Date.now() + code.expires_in * 1000;
  while (Date.now() + interval * 1000 < expires) {
    await sleep(interval * 1000);
    try {
      return token(await post(config.tokenEndpoint, { client_id: config.clientId, grant_type: deviceGrant, device_code: code.device_code }));
    } catch (error) {
      if (error.oauthCode === "slow_down") interval += 5;
      else if (error.oauthCode !== "authorization_pending") throw error;
    }
  }
  throw new Error("OAuth device login expired");
}

async function browserLogin(config, requestedPort, show) {
  if (!config.authorizationEndpoint || !config.pkce) throw new Error("The issuer must offer device login or authorization code with S256 PKCE");
  const port = requestedPort === undefined ? 0 : Number(requestedPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid OAuth redirect port");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const pending = Promise.withResolvers();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const valid = request.method === "GET" && url.pathname === "/oauth/callback" && url.searchParams.get("state") === state;
    response.writeHead(valid ? 200 : 400, { "content-type": "text/plain", "cache-control": "no-store", connection: "close" });
    response.end(valid ? "You can close this tab and return to Spool." : "Invalid OAuth callback.");
    if (valid) {
      if (code && !url.searchParams.has("error")) pending.resolve(code);
      else pending.reject(new Error("OAuth authorization was declined"));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const timer = setTimeout(() => pending.reject(new Error("OAuth browser login expired")), 300_000);
  try {
    const redirect = `http://127.0.0.1:${server.address().port}/oauth/callback`;
    const url = new URL(config.authorizationEndpoint);
    for (const [key, value] of Object.entries({ ...params(config), response_type: "code", redirect_uri: redirect, state,
      code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") })) {
      url.searchParams.set(key, value);
    }
    show(`Open ${url.href} to authorize Spool`);
    const code = await pending.promise;
    return token(await post(config.tokenEndpoint, { client_id: config.clientId, resource: config.resource, grant_type: "authorization_code",
      code, code_verifier: verifier, redirect_uri: redirect }));
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}

export async function loginOAuth(config, redirectPort, show) {
  const values = config.deviceEndpoint && redirectPort === undefined
    ? await deviceLogin(config, show) : await browserLogin(config, redirectPort, show);
  return { ...values, issuer: config.issuer, clientId: config.clientId, tokenEndpoint: config.tokenEndpoint };
}

export async function refreshOAuth(profile) {
  const endpoint = secureURL(profile.tokenEndpoint, new URL(profile.runner).protocol === "http:");
  return token(await post(endpoint, { client_id: profile.clientId, grant_type: "refresh_token",
    refresh_token: profile.refreshToken, resource: profile.runner }), profile.refreshToken);
}
