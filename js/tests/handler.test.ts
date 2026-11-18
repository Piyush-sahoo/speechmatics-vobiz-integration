/**
 * Feature: handleVobizCall - Vobiz audio stream event loop
 *
 * handleVobizCall is the WebSocket handler Vobiz talks to for the lifetime
 * of one call. It:
 *   - Receives JSON events ("start", then "media")
 *   - Creates a CallSession on "start", using the audio format Vobiz
 *     reports in start.mediaFormat
 *   - Forwards base64 payloads to the session by track label
 *   - Closes the session when the socket closes. Vobiz sends no "stop"
 *     event, so the end of the stream is the end of the call.
 *
 * The real WebSocket is replaced with a small EventEmitter-based fake,
 * and CallSession is spied on so no live services are touched.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi, afterEach } from "vitest";

import * as proxy from "../proxy.js";
import type { AudioFormat } from "../proxy.js";
const { handleVobizCall, CallSession } = proxy;

/**
 * FakeWS emulates the ws library's WebSocket surface just enough for
 * handleVobizCall: on("message"|"close"|"error") + close().
 */
class FakeWS extends EventEmitter {
  close(): void {
    this.emit("close");
  }
  emitEvent(event: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(event), "utf8"));
  }
  emitRaw(text: string): void {
    this.emit("message", Buffer.from(text, "utf8"));
  }
}

function startEvent(mediaFormat: { encoding: string; sampleRate: number } = {
  encoding: "audio/x-l16",
  sampleRate: 16000,
}) {
  // The identifiers live inside the nested `start` object, as on the wire.
  return {
    sequenceNumber: 0,
    event: "start",
    start: {
      callId: "5401fd2e-6344-40df-a22c-c8ffea7a92e7",
      streamId: "c4dfd815-a92a-4140-ab85-5ff28c004116",
      accountId: "500025",
      tracks: ["inbound", "outbound"],
      mediaFormat,
    },
    extra_headers: "{}",
  };
}

function mediaEvent(track: string, payload: string) {
  return {
    sequenceNumber: 2,
    streamId: "c4dfd815-a92a-4140-ab85-5ff28c004116",
    event: "media",
    media: { track, timestamp: "1778597597091", chunk: 2, payload },
    extra_headers: "{}",
  };
}

/**
 * Patch CallSession.prototype so handleVobizCall's `new CallSession()`
 * lands on our spies without needing DI plumbing in production code.
 * `formats` records the audio format each started session was built with.
 */
function stubCallSession() {
  const formats: AudioFormat[] = [];
  const spies = {
    start: vi.fn(function (this: InstanceType<typeof CallSession>) {
      formats.push(this.audioFormat);
    }),
    enqueue: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  vi.spyOn(CallSession.prototype, "start").mockImplementation(spies.start);
  vi.spyOn(CallSession.prototype, "enqueue").mockImplementation(spies.enqueue);
  vi.spyOn(CallSession.prototype, "close").mockImplementation(spies.close);
  return { spies, formats };
}

/** Collect console.error / console.log output while silencing it. */
function captureConsole() {
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return {
    err: () => err.mock.calls.map((c) => String(c[0])).join("\n"),
    log: () => log.mock.calls.map((c) => String(c[0])).join("\n"),
  };
}

async function run(events: unknown[]) {
  const ws = new FakeWS();
  const done = handleVobizCall(ws as unknown as import("ws").WebSocket);
  for (const event of events) ws.emitEvent(event);
  ws.close();
  await done;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleVobizCall - session lifecycle", () => {
  it("creates and starts a session on the start event", async () => {
    /**
     * Scenario: A well-formed Vobiz start event
     *   Given a fake WebSocket that delivers [start]
     *    When handleVobizCall consumes the stream
     *    Then session.start() was invoked exactly once
     *     And the session uses the L16/16 kHz format
     *
     * Purpose: guards the "call kicks off a Speechmatics session" step.
     */
    const { spies, formats } = stubCallSession();
    captureConsole();
    await run([startEvent()]);
    expect(spies.start).toHaveBeenCalledTimes(1);
    expect(formats[0]).toEqual(proxy.VOBIZ_AUDIO_FORMAT);
  });

  it.each([
    ["audio/x-l16", 16000, "pcm_s16le", 640],
    ["audio/x-l16", 8000, "pcm_s16le", 320],
    ["audio/x-mulaw", 8000, "mulaw", 160],
  ])("uses the %s/%i format Vobiz reports", async (encoding, sampleRate, expected, chunk) => {
    /**
     * Scenario Outline: The session decodes audio in the reported format
     *   Given a start event whose mediaFormat is <encoding>/<sampleRate>
     *    When handleVobizCall consumes it
     *    Then the session's format matches that encoding and rate
     *     And its chunk_size is one 20 ms frame
     *
     * Purpose: if someone edits the answer XML's contentType, the proxy
     * must follow rather than mis-decode.
     */
    const { formats } = stubCallSession();
    captureConsole();
    await run([startEvent({ encoding, sampleRate })]);
    expect(formats[0]).toEqual({ encoding: expected, sample_rate: sampleRate, chunk_size: chunk });
  });

  it("refuses an unsupported format loudly and transcribes nothing", async () => {
    /**
     * Scenario: Vobiz reports a format Speechmatics is not given
     *   Given a start event with mediaFormat audio/x-l16 at 24000 Hz
     *    When handleVobizCall consumes it and a media frame
     *    Then no session is started and nothing is enqueued
     *     And the reason is printed on stderr
     *
     * Purpose: sending audio under the wrong format produces garbage
     * transcripts with no error. Refusing loudly is better.
     */
    const { spies } = stubCallSession();
    const out = captureConsole();
    await run([startEvent({ encoding: "audio/x-l16", sampleRate: 24000 }), mediaEvent("inbound", "AAAA")]);
    expect(spies.start).not.toHaveBeenCalled();
    expect(spies.enqueue).not.toHaveBeenCalled();
    expect(out.err()).toContain("unsupported audio format");
  });

  it("ignores media events that arrive before start", async () => {
    /**
     * Scenario: A "media" event arrives before "start"
     *   Given a fake WebSocket that delivers [media]
     *    When handleVobizCall consumes the stream
     *    Then session.enqueue was never called
     *
     * Purpose: defensive - a reordered or broken stream must not crash
     * the handler on a null session.
     */
    const { spies } = stubCallSession();
    captureConsole();
    await run([mediaEvent("inbound", "AAA=")]);
    expect(spies.enqueue).not.toHaveBeenCalled();
  });
});

describe("handleVobizCall - audio forwarding", () => {
  it("passes each media payload through to session.enqueue with its track", async () => {
    /**
     * Scenario: Interleaved inbound + outbound media events
     *   Given start -> media(inbound) -> media(outbound)
     *    When handleVobizCall consumes the stream
     *    Then enqueue was called with ("inbound", <inbound payload>)
     *     And enqueue was called with ("outbound", <outbound payload>)
     *
     * Purpose: multi-channel diarization contract - the caller (inbound)
     * and the callee (outbound) must keep their own labels.
     */
    const { spies } = stubCallSession();
    captureConsole();
    await run([startEvent(), mediaEvent("inbound", "qqqq"), mediaEvent("outbound", "u7u7")]);
    expect(spies.enqueue.mock.calls).toContainEqual(["inbound", "qqqq"]);
    expect(spies.enqueue.mock.calls).toContainEqual(["outbound", "u7u7"]);
  });

  it("passes the base64 payload straight through (no decode)", async () => {
    /**
     * Scenario: A media event's payload is base64 text
     *   Given start -> media(inbound, "TWFrZQ==")
     *    When handleVobizCall consumes the stream
     *    Then enqueue is called with ("inbound", "TWFrZQ==") verbatim
     *
     * Purpose: the JS RT SDK's AddChannelAudio.data field expects base64,
     * exactly the shape Vobiz ships. Decoding then re-encoding wastes CPU.
     */
    const { spies } = stubCallSession();
    captureConsole();
    await run([startEvent(), mediaEvent("inbound", "TWFrZQ==")]);
    expect(spies.enqueue).toHaveBeenCalledWith("inbound", "TWFrZQ==");
  });

  it("treats a frame with no track label as the caller's", async () => {
    /**
     * Scenario: A media event without media.track
     *   Given start -> media with a payload but no track
     *    When handleVobizCall consumes the stream
     *    Then the frame is enqueued on "inbound"
     *
     * Purpose: matches the Python proxy's default.
     */
    const { spies } = stubCallSession();
    captureConsole();
    await run([startEvent(), { event: "media", media: { payload: "AAAA" } }]);
    expect(spies.enqueue).toHaveBeenCalledWith("inbound", "AAAA");
  });

  it("skips media events with no payload", async () => {
    /**
     * Scenario: A media event missing the payload key
     *   Given start -> {media without payload}
     *    When handleVobizCall consumes the stream
     *    Then session.enqueue was never called
     *
     * Purpose: defensive - a garbled event should be dropped, not crash
     * the handler.
     */
    const { spies } = stubCallSession();
    captureConsole();
    await run([startEvent(), { event: "media", media: { track: "inbound" } }]);
    expect(spies.enqueue).not.toHaveBeenCalled();
  });

  it("drops an undecodable payload, not the call", async () => {
    /**
     * Scenario: One media frame has a malformed base64 payload
     *   Given a good frame, a bad frame, then another good frame
     *    When handleVobizCall consumes the stream
     *    Then both good frames still reach the session
     *     And the bad frame is reported on stderr and tallied at the end
     *
     * Purpose: a bad frame should cost one frame of audio, not the call.
     */
    const { spies } = stubCallSession();
    const out = captureConsole();
    await run([
      startEvent(),
      mediaEvent("inbound", "AQI="),
      mediaEvent("inbound", "abcde"),
      mediaEvent("inbound", "AwQ="),
    ]);
    expect(spies.enqueue.mock.calls.map((c) => c[1])).toEqual(["AQI=", "AwQ="]);
    expect(spies.close).toHaveBeenCalledTimes(1);
    expect(out.err()).toContain("dropping undecodable audio frame");
    expect(out.err()).toContain("dropped 1 undecodable");
  });

  it("logs the first bad frame once and tallies the rest", async () => {
    /**
     * Scenario: A stream of malformed frames
     *   Given five consecutive bad payloads
     *    When handleVobizCall consumes them
     *    Then the per-frame warning is printed once
     *     And the end-of-call tally says five were dropped
     *
     * Purpose: at 50 frames/s per track a per-frame log would bury every
     * other line.
     */
    stubCallSession();
    const out = captureConsole();
    await run([startEvent(), ...Array(5).fill(mediaEvent("inbound", "ab!d"))]);
    expect(out.err().split("dropping undecodable audio frame").length - 1).toBe(1);
    expect(out.err()).toContain("dropped 5 undecodable");
  });

  it("ignores a non-JSON message and keeps the call going", async () => {
    /**
     * Scenario: A text frame that is not JSON
     *   Given start -> "not json" -> media(inbound)
     *    When handleVobizCall consumes the stream
     *    Then the later media frame is still enqueued
     *
     * Purpose: one malformed message must not end transcription for the
     * rest of the call.
     */
    const { spies } = stubCallSession();
    captureConsole();
    const ws = new FakeWS();
    const done = handleVobizCall(ws as unknown as import("ws").WebSocket);
    ws.emitEvent(startEvent());
    ws.emitRaw("not json");
    ws.emitEvent(mediaEvent("inbound", "AAAA"));
    ws.close();
    await done;
    expect(spies.enqueue).toHaveBeenCalledWith("inbound", "AAAA");
  });
});

describe("handleVobizCall - end of call", () => {
  it("closes the session when the socket closes, with no stop event", async () => {
    /**
     * Scenario: The call ends and Vobiz closes the socket
     *   Given an active call (start and media received)
     *    When the socket closes with no "stop" event
     *    Then session.close() is awaited exactly once
     *     And "call ended" is printed
     *
     * Purpose: Vobiz signals the end of a call only by closing the socket.
     * A handler that waited for a "stop" event would leak one session per
     * call.
     */
    const { spies } = stubCallSession();
    const out = captureConsole();
    await run([startEvent(), mediaEvent("inbound", "AAAA")]);
    expect(spies.close).toHaveBeenCalledTimes(1);
    expect(out.log()).toContain("call ended");
  });

  it("closes the session when the socket errors", async () => {
    /**
     * Scenario: The WebSocket drops abruptly mid-call
     *   Given an active call
     *    When the socket emits "error" instead of a clean close
     *    Then session.close() is still awaited exactly once
     *
     * Purpose: networks are unreliable - the error path must clean up too.
     */
    const { spies } = stubCallSession();
    captureConsole();
    const ws = new FakeWS();
    const done = handleVobizCall(ws as unknown as import("ws").WebSocket);
    ws.emitEvent(startEvent());
    ws.emit("error", new Error("ECONNRESET"));
    await done;
    expect(spies.close).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the socket closes before start", async () => {
    /**
     * Scenario: The socket opens and closes with no "start" event
     *   Given a WebSocket that sends nothing
     *    When it closes
     *    Then session.close() was never called (session is null)
     *
     * Purpose: awaiting a nonexistent session would crash.
     */
    const { spies } = stubCallSession();
    captureConsole();
    await run([]);
    expect(spies.close).not.toHaveBeenCalled();
  });
});
