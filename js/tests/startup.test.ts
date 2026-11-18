/**
 * Feature: Startup, command line and request routing (startProxy,
 * parseCliArgs, routeRequest)
 *
 *   - The environment is checked, then the Speechmatics key, before ngrok
 *     is opened or the Vobiz number is touched.
 *   - PUBLIC_URL (https only) replaces ngrok.
 *   - Inbound mode repoints the number; outbound mode (`--call`) places a
 *     call once the server is listening and leaves routing alone.
 *   - Only this run's tokenised /answer, /hangup and /vobiz paths exist.
 *   - Vobiz API failures end in one readable line, not a stack trace.
 *
 * Speechmatics auth, ngrok and global fetch are mocked. The only socket
 * opened is the proxy's own server on a random loopback port.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSpeechmaticsJWT: vi.fn(),
  ngrokForward: vi.fn(),
}));

vi.mock("@speechmatics/auth", () => ({ createSpeechmaticsJWT: mocks.createSpeechmaticsJWT }));
vi.mock("@ngrok/ngrok", () => ({ default: { forward: mocks.ngrokForward } }));

import type * as ProxyModule from "../proxy.js";

const BASE_ENV: Record<string, string> = {
  SPEECHMATICS_API_KEY: "test-key-not-real",
  NGROK_AUTHTOKEN: "test-ngrok-not-real",
  VOBIZ_AUTH_ID: "MA_TESTACCOUNT",
  VOBIZ_AUTH_TOKEN: "test-token-not-real",
  VOBIZ_PHONE_NUMBER: "+917700900456",
  FORWARD_TO_NUMBER: "+917700900789",
  SM_VOBIZ_PROXY_PORT: "0",
};
const ENV_KEYS = [...Object.keys(BASE_ENV), "PUBLIC_URL", "SPEECHMATICS_LANGUAGE"];
const savedEnv: Record<string, string | undefined> = {};

/** Load a fresh copy of proxy.ts with `overrides` applied to the env. */
async function loadProxy(overrides: Record<string, string | undefined> = {}): Promise<typeof ProxyModule> {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (value !== undefined) process.env[key] = value;
  }
  vi.resetModules();
  return import("../proxy.js");
}

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  serverListening: boolean | undefined;
}

let servers: http.Server[] = [];
let seen: Seen[] = [];
let logs: string[] = [];
let errors: string[] = [];
let fetchFails = false;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  servers = [];
  seen = [];
  logs = [];
  errors = [];
  fetchFails = false;

  mocks.createSpeechmaticsJWT.mockReset().mockResolvedValue("jwt");
  mocks.ngrokForward.mockReset().mockResolvedValue({ url: () => "https://tunnel.example.dev" });

  // Capture every server startProxy creates, so a fetch can check whether
  // it is already listening and afterEach can close it.
  const realCreate = http.createServer.bind(http);
  vi.spyOn(http, "createServer").mockImplementation(((...args: Parameters<typeof http.createServer>) => {
    const server = realCreate(...args);
    servers.push(server);
    return server;
  }) as typeof http.createServer);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace("https://api.vobiz.ai/api/v1/Account/MA_TESTACCOUNT", "");
      const method = init.method ?? "GET";
      seen.push({
        method,
        path,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        serverListening: servers.at(-1)?.listening,
      });
      if (fetchFails) return new Response('{"error":"authentication failed"}', { status: 401 });
      if (path.startsWith("/numbers?")) return Response.json({ items: [{ e164: "+917700900456", application_id: null }] });
      if (path.startsWith("/Application/?")) return Response.json({ meta: { next: null, total_count: 0 }, objects: [] });
      if (method === "POST" && path === "/Application/") return Response.json({ app_id: "111" });
      if (path === "/Call/") return Response.json({ request_uuid: "req-1" }, { status: 201 });
      return Response.json({ message: "ok" });
    }),
  );

  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(async () => {
  await Promise.all(
    servers.filter((s) => s.listening).map((s) => new Promise((resolve) => s.close(resolve))),
  );
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** GET a path on a server startProxy started, over loopback. */
function get(server: http.Server, path: string): Promise<{ status: number; type?: string; body: string }> {
  const { address, port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http
      .get({ host: address, port, path }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body }));
      })
      .on("error", reject);
  });
}

describe("startProxy - inbound and outbound modes", () => {
  it("inbound mode points the number at the proxy and places no call", async () => {
    /**
     * Scenario: Running with no flags
     *   Given no arguments
     *    When startProxy runs
     *    Then the number is looked up, the app created and the number attached
     *     And no outbound call is placed
     *     And the banner shows the tokenised /answer/<token> path
     */
    const proxy = await loadProxy();
    await proxy.startProxy([]);

    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /numbers?search=%2B917700900456",
      "GET /Application/?limit=100&offset=0",
      "POST /Application/",
      "POST /numbers/%2B917700900456/application",
    ]);
    expect(seen[2].body?.answer_url).toMatch(/^https:\/\/tunnel\.example\.dev\/answer\/[\w-]{22}$/);
    expect(logs.join("\n")).toContain("pointed at https://tunnel.example.dev/answer/<token>");
  });

  it("outbound mode places the call only after the server is listening", async () => {
    /**
     * Scenario: Running with --call
     *   Given `--call +917700900123`
     *    When startProxy runs
     *    Then POST /Call/ is sent, to that number, while the server is
     *         already listening
     *     And the number's inbound routing is not touched
     *     And the request UUID is printed
     *
     * Purpose: Vobiz fetches the answer URL as soon as the callee picks
     * up. If the server were not listening yet, that fetch would fail and
     * the call would drop.
     */
    const proxy = await loadProxy();
    await proxy.startProxy(["--call", "+917700900123"]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/Call/", serverListening: true });
    expect(seen[0].body).toMatchObject({ from: "+917700900456", to: "+917700900123" });
    expect(logs.join("\n")).toContain("request=req-1");
  });

  it("serves the answer XML and hangup on the URLs it gave Vobiz", async () => {
    /**
     * Scenario: Vobiz fetches the URLs from the call request
     *   Given an outbound run whose /Call/ request carried answer_url and
     *         hangup_url
     *    When those paths are fetched from the running server
     *    Then /answer returns the VobizXML pointing at wss://.../vobiz/<same token>
     *     And /hangup returns 200
     *     And a path with another token is a 404
     */
    const proxy = await loadProxy();
    const server = await proxy.startProxy(["--call", "+917700900123"]);
    const answerPath = new URL(String(seen[0].body?.answer_url)).pathname;
    const hangupPath = new URL(String(seen[0].body?.hangup_url)).pathname;
    const token = answerPath.split("/").at(-1);

    const answer = await get(server, `${answerPath}?CallUUID=abc`);
    expect(answer.status).toBe(200);
    expect(answer.type).toBe("application/xml");
    expect(answer.body).toContain(`wss://tunnel.example.dev/vobiz/${token}</Stream>`);
    expect((await get(server, hangupPath)).status).toBe(200);
    expect((await get(server, "/answer/not-the-token")).status).toBe(404);
  });
});

describe("startProxy - fail before side effects", () => {
  it("checks the Speechmatics key before opening ngrok or touching Vobiz", async () => {
    /**
     * Scenario: Startup order with a bad key
     *   Given the token request rejects
     *    When startProxy runs
     *    Then the process exits with code 1
     *     And ngrok is never started and Vobiz is never called
     */
    mocks.createSpeechmaticsJWT.mockRejectedValue(new Error("HTTP 401"));
    const proxy = await loadProxy();

    await expect(proxy.startProxy([])).rejects.toThrow("process.exit(1)");
    expect(mocks.ngrokForward).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("exits listing every missing env var", async () => {
    /**
     * Scenario: An incomplete .env
     *   Given VOBIZ_AUTH_TOKEN and FORWARD_TO_NUMBER are unset
     *    When startProxy runs
     *    Then it exits 1 naming both, before checking the key
     */
    const proxy = await loadProxy({ VOBIZ_AUTH_TOKEN: undefined, FORWARD_TO_NUMBER: undefined });

    await expect(proxy.startProxy([])).rejects.toThrow("process.exit(1)");
    expect(errors.join("\n")).toContain("Missing required env vars in .env: VOBIZ_AUTH_TOKEN, FORWARD_TO_NUMBER");
    expect(mocks.createSpeechmaticsJWT).not.toHaveBeenCalled();
  });

  it("prints one line, not a stack trace, when Vobiz rejects the credentials", async () => {
    /**
     * Scenario: Wrong VOBIZ_AUTH_TOKEN
     *   Given every Vobiz API call returns 401
     *    When startProxy runs in inbound mode
     *    Then "Could not configure the Vobiz number: ... 401 ..." is printed
     *     And the process exits with code 1
     */
    fetchFails = true;
    const proxy = await loadProxy();

    await expect(proxy.startProxy([])).rejects.toThrow("process.exit(1)");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Could not configure the Vobiz number: Vobiz API GET .* returned 401/);
  });

  it("prints one line when the outbound call cannot be placed", async () => {
    /**
     * Scenario: --call with an API failure
     *   Given POST /Call/ returns 401
     *    When startProxy runs with --call
     *    Then "Could not place the call: ..." is printed and it exits 1
     */
    fetchFails = true;
    const proxy = await loadProxy();

    await expect(proxy.startProxy(["--call", "+917700900123"])).rejects.toThrow("process.exit(1)");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Could not place the call: Vobiz API POST \/Call\/ returned 401/);
  });
});

describe("startProxy - PUBLIC_URL", () => {
  it("uses PUBLIC_URL instead of ngrok, without needing NGROK_AUTHTOKEN", async () => {
    /**
     * Scenario: An existing tunnel
     *   Given PUBLIC_URL=https://my-tunnel.example.dev/ and no NGROK_AUTHTOKEN
     *    When startProxy runs
     *    Then ngrok is not started
     *     And the answer URL is built on PUBLIC_URL, trailing slash removed
     */
    const proxy = await loadProxy({ PUBLIC_URL: "https://my-tunnel.example.dev/", NGROK_AUTHTOKEN: undefined });
    await proxy.startProxy(["--call", "+917700900123"]);

    expect(mocks.ngrokForward).not.toHaveBeenCalled();
    expect(String(seen[0].body?.answer_url)).toMatch(/^https:\/\/my-tunnel\.example\.dev\/answer\//);
  });

  it("refuses a PUBLIC_URL that is not https", async () => {
    /**
     * Scenario: A plain-http tunnel URL
     *   Given PUBLIC_URL=http://my-tunnel.example.dev
     *    When startProxy runs
     *    Then it exits 1 explaining that https is required
     *     And nothing else is started
     *
     * Purpose: the stream URL is derived by swapping https for wss. An
     * http URL would hand Vobiz an http:// stream URL it cannot open.
     */
    const proxy = await loadProxy({ PUBLIC_URL: "http://my-tunnel.example.dev" });

    await expect(proxy.startProxy([])).rejects.toThrow("process.exit(1)");
    expect(errors.join("\n")).toContain("PUBLIC_URL must start with https://");
    expect(mocks.createSpeechmaticsJWT).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });
});

describe("parseCliArgs", () => {
  it("reads --call, and defaults to inbound mode", async () => {
    /**
     * Scenario: Command-line flags
     *   Given `--call +917700900123`
     *    When the arguments are parsed
     *    Then call is that number
     *     And with no flags call is undefined (inbound mode)
     */
    const proxy = await loadProxy();
    expect(proxy.parseCliArgs(["--call", "+917700900123"]).call).toBe("+917700900123");
    expect(proxy.parseCliArgs([]).call).toBeUndefined();
  });

  it("exits 2 with usage on an unknown flag", async () => {
    /**
     * Scenario: A typo on the command line
     *   Given `--cal +917700900123`
     *    When the arguments are parsed
     *    Then the process exits with code 2 and prints usage
     *
     * Purpose: silently ignoring the typo would repoint the number in
     * inbound mode when the operator meant to place a call.
     */
    const proxy = await loadProxy();
    expect(() => proxy.parseCliArgs(["--cal", "+917700900123"])).toThrow("process.exit(2)");
    expect(errors.join("\n")).toContain("usage:");
  });
});

describe("routeRequest", () => {
  const routes = {
    answerPath: "/answer/tok",
    hangupPath: "/hangup/tok",
    streamPath: "/vobiz/tok",
    answerBody: "<Response/>",
  };

  it("serves the answer XML on GET, ignoring the query string", async () => {
    /**
     * Scenario: Vobiz fetches the answer URL with call parameters appended
     *   Given GET /answer/tok?CallUUID=...&From=...
     *    When it is routed
     *    Then the answer XML is returned as application/xml with a
     *         correct Content-Length
     */
    const { routeRequest } = await loadProxy();
    const result = routeRequest("GET", "/answer/tok?CallUUID=x&From=%2B91", routes);
    expect(result).toEqual({
      status: 200,
      headers: { "Content-Type": "application/xml", "Content-Length": "11" },
      body: "<Response/>",
    });
  });

  it("acknowledges the hangup callback with an empty 200", async () => {
    /**
     * Scenario: Vobiz reports the end of the call
     *   Given GET /hangup/tok?...
     *    When it is routed
     *    Then the response is 200 with an empty body
     */
    const { routeRequest } = await loadProxy();
    expect(routeRequest("GET", "/hangup/tok?Duration=12", routes)).toMatchObject({ status: 200, body: "" });
  });

  it("404s any path without this run's token", async () => {
    /**
     * Scenario: A scanner or a stale application hits the server
     *   Given /answer, /answer/other, /hangup/other and /
     *    When they are routed
     *    Then each is a 404
     *
     * Purpose: the token is the only thing keeping the answer XML and the
     * audio stream private to this run.
     */
    const { routeRequest } = await loadProxy();
    for (const url of ["/answer", "/answer/other", "/hangup/other", "/", undefined]) {
      expect(routeRequest("GET", url, routes).status).toBe(404);
    }
  });

  it("allows only GET on the callback paths", async () => {
    /**
     * Scenario: A callback arrives with the wrong method
     *   Given POST /answer/tok
     *    When it is routed
     *    Then the response is 405 with Allow: GET
     *
     * Purpose: the application is configured with GET; a POST means the
     * application's method was changed by hand.
     */
    const { routeRequest } = await loadProxy();
    expect(routeRequest("POST", "/answer/tok", routes)).toMatchObject({
      status: 405,
      headers: { Allow: "GET" },
    });
  });

  it("recognises the stream path only for WebSocket upgrades", async () => {
    /**
     * Scenario: The audio stream path
     *   Given /vobiz/tok with and without a query string
     *    When it is checked as an upgrade, and as a plain GET
     *    Then the upgrade is accepted and another token is not
     *     And a plain GET is told to upgrade (426)
     */
    const { isStreamRequest, routeRequest } = await loadProxy();
    expect(isStreamRequest("/vobiz/tok", routes)).toBe(true);
    expect(isStreamRequest("/vobiz/tok?x=1", routes)).toBe(true);
    expect(isStreamRequest("/vobiz/other", routes)).toBe(false);
    expect(routeRequest("GET", "/vobiz/tok", routes).status).toBe(426);
  });
});
