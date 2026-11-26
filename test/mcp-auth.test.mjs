import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { authCommand, runnerConnection } from "../bin/mcp-auth.mjs";
import { parseCli } from "../bin/mcp-config.mjs";

async function fixture(t, scheme, dispatch = () => undefined) {
  const directory = await mkdtemp(join(tmpdir(), "spool-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { SPOOL_AUTH_DIR: directory };
  const credentials = new Set(["operator-credential", "oauth-access", "oauth-fresh"]);
  const server = createServer(async (request, response) => {
    const json = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.url === "/.well-known/portable-task-runner") return json({ auth: scheme });
      if (request.url === "/.well-known/oauth-protected-resource") {
        return json({ resource: runner, authorization_servers: [runner + "/tenant"], scopes_supported: ["spool:run"] });
      }
      if (request.url === "/v1/auth/check") {
        response.writeHead(credentials.has(request.headers.authorization?.slice(7)) ? 204 : 401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const result = await dispatch(request.url, form, runner);
      if (!result) return json({}, 404);
      return json(...result);
    } catch (error) { return json({ detail: error.message }, 500); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const runner = "http://127.0.0.1:" + server.address().port;
  return { env, runner };
}

test("bearer profiles validate credentials and stay bound to their runner", async (t) => {
  const { env, runner } = await fixture(t, "bearer-token");
  const options = parseCli(["auth", "login", "--profile", "personal", "--runner", runner, "--token-stdin"]);
  await assert.rejects(authCommand(options, env, { input: Readable.from([Buffer.from("bad\n")]) }), /401/);
  const result = await authCommand(options, env, { input: Readable.from([Buffer.from("operator-credential\n")]) });
  assert.deepEqual(result, { profile: "personal", runner, scheme: "bearer" });
  assert.deepEqual(await authCommand({ action: "list" }, env), [result]);
  if (process.platform !== "win32") assert.equal((await stat(join(env.SPOOL_AUTH_DIR, "personal.json"))).mode & 0o777, 0o600);
  await assert.rejects(runnerConnection({ profile: "personal", runner: "https://another.runner.test" }, env), /different runner/);
  const connection = await runnerConnection({ profile: "personal" }, env);
  assert.deepEqual(await connection.headers(), { authorization: "Bearer operator-credential" });
  await authCommand({ action: "logout", profile: "personal" }, env);
  await assert.rejects(connection.headers(), /auth login/);
});

test("OAuth device discovery refreshes once across concurrent profile consumers", async (t) => {
  let polls = 0;
  let refreshes = 0;
  const { env, runner } = await fixture(t, "oauth-bearer", (path, form, origin) => {
    if (path === "/.well-known/oauth-authorization-server/tenant") return [{
      issuer: origin + "/tenant", token_endpoint: origin + "/token", device_authorization_endpoint: origin + "/device",
      token_endpoint_auth_methods_supported: ["none"],
    }];
    if (path === "/device") {
      assert.equal(form.get("client_id"), "registered-client");
      assert.equal(form.get("resource"), origin);
      assert.equal(form.get("scope"), "spool:run");
      return [{ device_code: "device", user_code: "USER", verification_uri: origin + "/verify", expires_in: 10, interval: 1 }];
    }
    if (path !== "/token") return;
    if (form.get("grant_type") === "refresh_token") {
      assert.equal(form.get("refresh_token"), "oauth-refresh");
      refreshes++;
      return [{ access_token: "oauth-fresh", refresh_token: "rotated", token_type: "Bearer", expires_in: 3600 }];
    }
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(form.get("device_code"), "device");
    if (++polls === 1) return [{ error: "authorization_pending" }, 400];
    return [{ access_token: "oauth-access", refresh_token: "oauth-refresh", token_type: "Bearer", expires_in: 15 }];
  });
  const output = [];
  const result = await authCommand({ action: "login", profile: "oauth", runner, "client-id": "registered-client" }, env, { show: (text) => output.push(text) });
  assert.equal(result.issuer, runner + "/tenant");
  assert.match(output[0], /USER/);
  const connections = await Promise.all([1, 2].map(() => runnerConnection({ profile: "oauth" }, env)));
  assert.deepEqual(await Promise.all(connections.map((connection) => connection.headers())), [
    { authorization: "Bearer oauth-fresh" }, { authorization: "Bearer oauth-fresh" },
  ]);
  assert.equal(refreshes, 1);
});

test("authorization code login validates browser state and uses S256 PKCE", async (t) => {
  let authorization;
  const { env, runner } = await fixture(t, "oauth-bearer", (path, form, origin) => {
    if (path === "/tenant/.well-known/openid-configuration") return [{
      issuer: origin + "/tenant", token_endpoint: origin + "/token", authorization_endpoint: origin + "/authorize",
      code_challenge_methods_supported: ["S256"],
    }];
    if (path !== "/token") return;
    assert.equal(form.get("code"), "browser-code");
    assert.equal(form.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
    assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), authorization.searchParams.get("code_challenge"));
    return [{ access_token: "oauth-access", token_type: "Bearer", expires_in: 3600 }];
  });
  let callback;
  await authCommand({ action: "login", profile: "browser", runner, "client-id": "public-client" }, env, {
    show(text) {
      authorization = new URL(text.split(" ")[1]);
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      callback = (async () => {
        const url = new URL(authorization.searchParams.get("redirect_uri"));
        url.searchParams.set("state", "invalid");
        assert.equal((await fetch(url)).status, 400);
        url.searchParams.set("state", authorization.searchParams.get("state"));
        url.searchParams.set("code", "browser-code");
        assert.equal((await fetch(url)).status, 200);
      })();
    },
  });
  await callback;
});
