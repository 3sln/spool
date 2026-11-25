import { canonical, Fault, readJSON, sha256 } from "./contract.mjs";

const denied = () => new Fault("UNAUTHORIZED", "Valid authentication is required", 401);

export const bearer = (request) => /^Bearer ([^ ]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

export function staticToken(token) {
  if (typeof token !== "string" || token.length < 24 || !/^[!-~]+$/u.test(token)) {
    throw new Error("Set a random bearer token of at least 24 visible ASCII characters");
  }
  let expected;
  return async (candidate) => {
    if (!candidate || candidate.length > 4096) return false;
    const actual = await sha256(candidate);
    expected ??= await sha256(token);
    // Compare fixed-width digests without an early mismatch exit.
    let delta = 0;
    for (let i = 0; i < actual.length; i++) delta |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    return delta === 0;
  };
}

function secureURL(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`Invalid ${label} URL`);
  return url;
}

function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/u.test(part)) throw denied();
  return Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (byte) => byte.charCodeAt(0));
}
function segment(part) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(part))); }

export function jwtVerifier({ issuer, audience, jwksURL, algorithm = "RS256", fetcher = fetch }) {
  secureURL(issuer, "issuer");
  secureURL(jwksURL, "JWKS");
  if (!audience) throw new Error("JWT audience is required");
  const algorithms = {
    RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: "RSASSA-PKCS1-v1_5" },
    ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  };
  const parameters = algorithms[algorithm];
  if (!parameters) throw new Error("JWT algorithm must be RS256 or ES256");

  let keys = [];
  let expires = 0;
  let lastFetch = -Infinity;
  let loading;
  async function findKey(kid) {
    let match = Date.now() < expires && keys.find((key) => key.kid === kid);
    if (!match && Date.now() - lastFetch >= 15_000) {
      lastFetch = Date.now();
      loading = (async () => {
        const response = await fetcher(jwksURL, { redirect: "error", signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw denied();
        const body = await readJSON(response, 128 * 1024);
        if (!Array.isArray(body.keys)) throw denied();
        keys = body.keys.filter((key) => key?.kid && (!key.use || key.use === "sig") && (!key.alg || key.alg === algorithm));
        expires = Date.now() + 5 * 60_000;
      })().finally(() => { loading = undefined; });
    }
    if (!match && loading) await loading;
    match ||= Date.now() < expires && keys.find((key) => key.kid === kid);
    if (!match) throw denied();
    return crypto.subtle.importKey("jwk", match, parameters.import, false, ["verify"]);
  }

  return async (token) => {
    try {
      if (!token || token.length > 16_384) throw denied();
      const parts = token.split(".");
      if (parts.length !== 3) throw denied();
      const header = segment(parts[0]);
      if (header.alg !== algorithm || !header.kid || typeof header.kid !== "string" || header.crit !== undefined) throw denied();
      const claims = segment(parts[1]);
      const now = Date.now() / 1000;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== issuer || !audiences.includes(audience) || !Number.isFinite(claims.exp) || claims.exp <= now
        || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))) throw denied();
      const key = await findKey(header.kid);
      const bytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      if (!await crypto.subtle.verify(parameters.verify, key, decode(parts[2]), bytes)) throw denied();
      return claims;
    } catch { throw denied(); }
  };
}

// Custom deployments can supply an object with authenticate(request), profile and optional metadata.
export function configuredAuth(env) {
  const mode = env.SPOOL_AUTH ?? "token";
  if (mode === "token") {
    const matches = staticToken(env.SPOOL_TOKEN);
    return {
      profile: "bearer-token", challenge: "Bearer",
      async authenticate(request) {
        if (!await matches(bearer(request))) throw denied();
        return { issuer: "spool-local", subject: env.SPOOL_TENANT ?? "operator" };
      },
    };
  }
  if (mode !== "access" && mode !== "oauth") throw new Error("SPOOL_AUTH must be token, access, or oauth");
  const access = mode === "access";
  const issuer = env.SPOOL_ISSUER;
  if (access && !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(issuer ?? "")) {
    throw new Error("Set SPOOL_ISSUER to the Access team URL");
  }
  const verify = jwtVerifier({
    issuer, audience: env.SPOOL_AUDIENCE,
    jwksURL: access ? `${issuer}/cdn-cgi/access/certs` : env.SPOOL_JWKS_URL,
    algorithm: access ? "RS256" : env.SPOOL_JWT_ALGORITHM,
  });
  if (!access && !env.SPOOL_PUBLIC_URL) throw new Error("OAuth requires SPOOL_PUBLIC_URL");
  const origin = access ? null : secureURL(env.SPOOL_PUBLIC_URL, "public").origin;
  const scope = env.SPOOL_OAUTH_SCOPE ?? "spool:run";
  return {
    profile: access ? "cloudflare-access" : "oauth-bearer",
    challenge: access ? undefined : `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    metadata: access ? undefined : {
      resource: origin, authorization_servers: [issuer], scopes_supported: [scope], bearer_methods_supported: ["header"],
    },
    async authenticate(request) {
      const claims = await verify(access ? request.headers.get("cf-access-jwt-assertion") : bearer(request));
      if (!access && (typeof claims.scope !== "string" || !claims.scope.split(" ").includes(scope))) {
        throw new Fault("FORBIDDEN", "Token scope does not allow execution", 403);
      }
      // Access service tokens can carry common_name instead of a human subject.
      const subject = claims.sub || (access && typeof claims.common_name === "string" ? `access-service:${claims.common_name}` : undefined);
      if (typeof subject !== "string" || !subject || subject.length > 1024) throw denied();
      return { issuer, subject };
    },
  };
}

export async function tenantFor(auth, request) {
  const { issuer, subject } = await auth.authenticate(request);
  if (typeof issuer !== "string" || !issuer || typeof subject !== "string" || !subject) throw denied();
  return (await sha256(canonical([issuer, subject]))).slice(7);
}
