/**
 * Feature: Talking to the Vobiz REST API (pointVobizNumber,
 * placeOutboundCall, vobizRequest)
 *
 * Vobiz routes an inbound call through the application its number is
 * attached to. On startup the proxy:
 *
 *   1. Looks the number up on the account (GET /numbers?search=...).
 *   2. Pages through the applications for one named
 *      speechmatics-transcription-<digits>, and creates or updates it with
 *      GET answer and hangup URLs on the tunnel.
 *   3. Attaches the number to that application.
 *
 * Every failure on the way - an HTTP error, a network error, a non-JSON
 * body, a create response without app_id - surfaces as one VobizApiError
 * so main() can print a single clear line instead of a stack trace.
 *
 * global fetch is stubbed, so these tests never touch the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.VOBIZ_AUTH_ID = "MA_TESTACCOUNT";
  process.env.VOBIZ_AUTH_TOKEN = "test-token-not-real";
  process.env.VOBIZ_PHONE_NUMBER = "+917700900123";
});

import {
  appNameFor,
  placeOutboundCall,
  pointVobizNumber,
  VOBIZ_API_BASE,
  VobizApiError,
  vobizRequest,
} from "../proxy.js";

const NUMBER = "+917700900123";
const APP_NAME = "speechmatics-transcription-917700900123";
const ANSWER = "https://tunnel.example.dev/answer/abc";
const HANGUP = "https://tunnel.example.dev/hangup/abc";
const ACCOUNT_BASE = `${VOBIZ_API_BASE}/Account/MA_TESTACCOUNT`;

interface Seen {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Handler = (method: string, path: string, body: unknown) => Response | Promise<Response>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

/** Stub global fetch with `handler`; returns the list of requests it saw. */
function stubFetch(handler: Handler): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      expect(url.startsWith(ACCOUNT_BASE)).toBe(true);
      const path = url.slice(ACCOUNT_BASE.length);
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ method, path, body, headers: init.headers as Record<string, string> });
      return handler(method, path, body);
    }),
  );
  return seen;
}

/** A plausible Vobiz account: the number, and `pages` of applications. */
function fakeAccount(options: { numberApp?: string | null; pages?: { app_id: string; app_name: string }[][] } = {}) {
  const pages = options.pages ?? [[]];
  const total = pages.reduce((n, p) => n + p.length, 0);
  return (method: string, path: string): Response => {
    if (method === "GET" && path.startsWith("/numbers")) {
      return json({ items: [{ e164: NUMBER, application_id: options.numberApp ?? null }] });
    }
    if (method === "GET" && path.startsWith("/Application/")) {
      const offset = Number(new URL(path, "https://x").searchParams.get("offset"));
      const index = offset / 100;
      const last = index >= pages.length - 1;
      return json({
        meta: { limit: 100, offset, total_count: total, next: last ? null : "next-page" },
        objects: pages[index] ?? [],
      });
    }
    if (method === "POST" && path === "/Application/") {
      return json({ app_id: "111", message: "created" });
    }
    return json({ message: "ok" });
  };
}

beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("appNameFor", () => {
  it("names the application after the number's digits", () => {
    /**
     * Scenario: Application name for a number
     *   Given +917700900123
     *    When the name is derived
     *    Then it is speechmatics-transcription-917700900123
     *
     * Purpose: one application per number, so running the proxy for two
     * numbers on one account doesn't repoint the other number's calls.
     */
    expect(appNameFor(NUMBER)).toBe(APP_NAME);
  });
});

describe("pointVobizNumber", () => {
  it("creates the app and attaches the number on first run", async () => {
    /**
     * Scenario: First run on an account
     *   Given no application named for this number exists
     *    When the number is pointed at the proxy
     *    Then an application is created with GET answer and hangup URLs
     *     And the number is attached to it, URL-encoded in the path
     *
     * Purpose: the proxy's server only answers GET, and Vobiz needs the
     * "+" in the number path encoded as %2B or the number is not matched.
     */
    const seen = stubFetch(fakeAccount());
    await pointVobizNumber(ANSWER, HANGUP);

    expect(seen[0]).toMatchObject({ method: "GET", path: "/numbers?search=%2B917700900123" });
    const created = seen.find((s) => s.method === "POST" && s.path === "/Application/");
    expect(created?.body).toEqual({
      app_name: APP_NAME,
      answer_url: ANSWER,
      answer_method: "GET",
      hangup_url: HANGUP,
      hangup_method: "GET",
    });
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      path: "/numbers/%2B917700900123/application",
      body: { application_id: "111" },
    });
  });

  it("updates the existing app in place on later runs", async () => {
    /**
     * Scenario: A later run on the same account
     *   Given an application named for this number already exists
     *    When the number is pointed at the proxy
     *    Then that application's URLs are updated in place
     *     And no second application is created
     *
     * Purpose: each run gets a new tunnel URL. Creating an application per
     * run would litter the account.
     */
    const seen = stubFetch(fakeAccount({ pages: [[{ app_id: "222", app_name: APP_NAME }]] }));
    await pointVobizNumber(ANSWER, HANGUP);

    expect(seen.some((s) => s.method === "POST" && s.path === "/Application/")).toBe(false);
    const update = seen.find((s) => s.path === "/Application/222/");
    expect(update).toMatchObject({ method: "POST", body: { answer_url: ANSWER, hangup_url: HANGUP } });
    expect(seen.at(-1)?.body).toEqual({ application_id: "222" });
  });

  it("pages through the applications until it finds the right one", async () => {
    /**
     * Scenario: The app is on the second page
     *   Given 100 other applications on page one and ours on page two
     *    When the number is pointed at the proxy
     *    Then both pages are fetched (offset 0, then 100)
     *     And the existing app is updated rather than duplicated
     *
     * Purpose: an account with more than 100 applications would otherwise
     * get a fresh duplicate on every run.
     */
    const pageOne = Array.from({ length: 100 }, (_, i) => ({ app_id: `x${i}`, app_name: `other-${i}` }));
    const seen = stubFetch(fakeAccount({ pages: [pageOne, [{ app_id: "333", app_name: APP_NAME }]] }));
    await pointVobizNumber(ANSWER, HANGUP);

    const listed = seen.filter((s) => s.method === "GET" && s.path.startsWith("/Application/"));
    expect(listed.map((s) => s.path)).toEqual([
      "/Application/?limit=100&offset=0",
      "/Application/?limit=100&offset=100",
    ]);
    expect(seen.some((s) => s.path === "/Application/333/")).toBe(true);
    expect(seen.some((s) => s.method === "POST" && s.path === "/Application/")).toBe(false);
  });

  it("stops paging when meta.next is null and creates the app", async () => {
    /**
     * Scenario: The last page has been read without a match
     *   Given one page of other applications with meta.next null
     *    When the number is pointed at the proxy
     *    Then only that one page is fetched
     *     And the application is created
     */
    const seen = stubFetch(fakeAccount({ pages: [[{ app_id: "9", app_name: "speechmatics-transcription" }]] }));
    await pointVobizNumber(ANSWER, HANGUP);

    expect(seen.filter((s) => s.path.startsWith("/Application/?")).length).toBe(1);
    expect(seen.some((s) => s.method === "POST" && s.path === "/Application/")).toBe(true);
  });

  it("returns the previous app so it can be restored", async () => {
    /**
     * Scenario: The number was routed somewhere else before
     *   Given the number is attached to application 999
     *    When the number is pointed at the proxy
     *    Then 999 is returned
     *
     * Purpose: attaching overwrites the old binding. Telling the operator
     * what it was lets them put production routing back.
     */
    stubFetch(fakeAccount({ numberApp: "999" }));
    await expect(pointVobizNumber(ANSWER, HANGUP)).resolves.toBe("999");
  });

  it("returns null when the number was already on our app", async () => {
    /**
     * Scenario: A re-run with the number already attached to our app
     *   Given the number's application_id is our app's id
     *    When the number is pointed at the proxy
     *    Then null is returned, so no "re-attach it" hint is printed
     */
    stubFetch(fakeAccount({ numberApp: "222", pages: [[{ app_id: "222", app_name: APP_NAME }]] }));
    await expect(pointVobizNumber(ANSWER, HANGUP)).resolves.toBeNull();
  });

  it("exits without changes when the number is not on the account", async () => {
    /**
     * Scenario: The number does not belong to this account
     *   Given the number search returns no exact match
     *    When the number is pointed at the proxy
     *    Then the process exits with code 1
     *     And no application is created or attached
     *
     * Purpose: a typo in VOBIZ_PHONE_NUMBER should fail clearly, not create
     * an application that nothing routes to.
     */
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen = stubFetch(() => json({ items: [{ e164: "+910000000000" }] }));

    await expect(pointVobizNumber(ANSWER, HANGUP)).rejects.toThrow("process.exit(1)");
    expect(seen.map((s) => s.path)).toEqual(["/numbers?search=%2B917700900123"]);
    expect(String(error.mock.calls[0][0])).toContain("not found on this account");
  });

  it("raises VobizApiError when the create response has no app_id", async () => {
    /**
     * Scenario: Vobiz answers the create with an unexpected body
     *   Given POST /Application/ returns 200 without app_id
     *    When the number is pointed at the proxy
     *    Then a VobizApiError is raised
     *     And the number is not attached to "undefined"
     */
    const base = fakeAccount();
    const seen = stubFetch((method, path) =>
      method === "POST" && path === "/Application/" ? json({ message: "created" }) : base(method, path),
    );
    await expect(pointVobizNumber(ANSWER, HANGUP)).rejects.toBeInstanceOf(VobizApiError);
    expect(seen.some((s) => s.path.endsWith("/application"))).toBe(false);
  });
});

describe("placeOutboundCall", () => {
  it("asks Vobiz to call from the Vobiz number with GET callbacks", async () => {
    /**
     * Scenario: Placing the call
     *   Given a destination number
     *    When the outbound call is placed
     *    Then Vobiz is asked to call it from VOBIZ_PHONE_NUMBER
     *     And the answer and hangup URLs use GET
     *     And the request UUID from the response is returned
     *
     * Purpose: the proxy's server only answers GET, and Vobiz rejects a
     * `from` number the account does not own.
     */
    const seen = stubFetch(() => json({ request_uuid: "req-1", message: "call fired" }, 201));
    await expect(placeOutboundCall("+917700900456", ANSWER, HANGUP)).resolves.toBe("req-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/Call/",
      body: {
        from: NUMBER,
        to: "+917700900456",
        answer_url: ANSWER,
        answer_method: "GET",
        hangup_url: HANGUP,
        hangup_method: "GET",
      },
    });
  });
});

describe("vobizRequest", () => {
  it("authenticates with X-Auth-ID / X-Auth-Token and sends JSON", async () => {
    /**
     * Scenario: Request shape
     *   Given any API call
     *    When it is sent
     *    Then it goes to /api/v1/Account/<auth id>/...
     *     And carries X-Auth-ID, X-Auth-Token and a JSON content type
     */
    const seen = stubFetch(() => json({ ok: true }));
    await vobizRequest("POST", "/Call/", { a: 1 });
    expect(seen[0].headers).toMatchObject({
      "X-Auth-ID": "MA_TESTACCOUNT",
      "X-Auth-Token": "test-token-not-real",
      "Content-Type": "application/json",
    });
  });

  it("wraps an HTTP error status with the status code and body", async () => {
    /**
     * Scenario: Bad credentials
     *   Given Vobiz answers 401
     *    When a request is made
     *    Then a VobizApiError names the method, path and status
     */
    stubFetch(() => new Response('{"error":"invalid auth"}', { status: 401 }));
    const err = await vobizRequest("GET", "/numbers?search=x").catch((e) => e);
    expect(err).toBeInstanceOf(VobizApiError);
    expect(err.message).toContain("GET /numbers?search=x returned 401");
    expect(err.message).toContain("invalid auth");
  });

  it("wraps a network failure", async () => {
    /**
     * Scenario: DNS failure or timeout
     *   Given fetch itself rejects
     *    When a request is made
     *    Then a VobizApiError is raised, not the raw TypeError
     *
     * Purpose: main() prints "Could not configure the Vobiz number: ..."
     * for VobizApiError; anything else would be a stack trace.
     */
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const err = await vobizRequest("GET", "/numbers").catch((e) => e);
    expect(err).toBeInstanceOf(VobizApiError);
    expect(err.message).toContain("fetch failed");
  });

  it("wraps a non-JSON body", async () => {
    /**
     * Scenario: A proxy or gateway returns an HTML page with 200
     *   Given the body is not JSON
     *    When a request is made
     *    Then a VobizApiError says so
     */
    stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    await expect(vobizRequest("GET", "/numbers")).rejects.toThrow(/non-JSON/);
  });

  it("treats an empty success body as {}", async () => {
    /**
     * Scenario: Vobiz returns 204-style empty success
     *   Given an empty 200 body
     *    When a request is made
     *    Then it resolves to {}
     */
    stubFetch(() => new Response("", { status: 200 }));
    await expect(vobizRequest("POST", "/Application/1/", {})).resolves.toEqual({});
  });
});
