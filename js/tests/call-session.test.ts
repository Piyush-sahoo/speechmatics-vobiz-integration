/**
 * Feature: CallSession routing + audio wire-format invariants
 *
 *   1. Audio wire format: we forward Vobiz's 16-bit PCM / 16 kHz frames
 *      straight through, no transcoding, and fall back to whatever format
 *      Vobiz reports in start.mediaFormat.
 *   2. Track routing: each Vobiz 'media' event carries a `track` label
 *      ("inbound" for the caller, "outbound" for the callee); frames must
 *      land in the Speechmatics channel that matches that label.
 *
 * These tests don't spin up a real Speechmatics session - we stub
 * MultiChannelRealtimeClient onto the session and assert on the calls it
 * receives.
 */

import { describe, expect, it, vi } from "vitest";

import {
  audioFormatFor,
  CallSession,
  CHANNELS,
  VOBIZ_AUDIO_FORMAT,
  VOBIZ_CONTENT_TYPE,
} from "../proxy.js";

describe("audio format constants", () => {
  it("matches the format the answer XML asks Vobiz for", () => {
    /**
     * Scenario: The audio format we advertise to Speechmatics
     *   Given the module-level VOBIZ_AUDIO_FORMAT constant
     *    When it is inspected
     *    Then encoding is pcm_s16le, sample_rate 16000, chunk_size 640
     *     And the answer XML's contentType asks for that same format
     *
     * Purpose: guards the "no transcoding" property. If the two drift
     * apart, Speechmatics interprets the bytes wrongly and produces
     * garbage with no error.
     */
    expect(VOBIZ_AUDIO_FORMAT).toEqual({ encoding: "pcm_s16le", sample_rate: 16000, chunk_size: 640 });
    expect(VOBIZ_CONTENT_TYPE).toBe("audio/x-l16;rate=16000");
  });

  it.each([
    ["audio/x-l16", 16000, "pcm_s16le", 640],
    ["audio/x-l16", 8000, "pcm_s16le", 320],
    ["audio/x-mulaw", 8000, "mulaw", 160],
  ])("maps %s at %i Hz to %s with %i-byte frames", (encoding, sampleRate, expected, chunk) => {
    /**
     * Scenario Outline: Formats Vobiz can report in start.mediaFormat
     *   Given a mediaFormat of <encoding>/<sampleRate>
     *    When it is looked up
     *    Then the Speechmatics encoding and rate match
     *     And chunk_size is one 20 ms frame
     *
     * Purpose: editing the answer XML's contentType must need no other
     * change - the proxy follows what Vobiz says it is sending.
     */
    expect(audioFormatFor({ encoding, sampleRate })).toEqual({
      encoding: expected,
      sample_rate: sampleRate,
      chunk_size: chunk,
    });
  });

  it("returns null for a format Speechmatics is not given", () => {
    /**
     * Scenario: An unsupported or missing mediaFormat
     *   Given L16 at 24 kHz, or no mediaFormat at all
     *    When it is looked up
     *    Then the result is null
     */
    expect(audioFormatFor({ encoding: "audio/x-l16", sampleRate: 24000 })).toBeNull();
    expect(audioFormatFor({})).toBeNull();
  });
});

describe("CHANNELS constant", () => {
  it("matches Vobiz's own track labels", () => {
    /**
     * Scenario: Channel identifiers registered with Speechmatics
     *   Given the module-level CHANNELS constant
     *    When it is inspected
     *    Then it equals ["inbound", "outbound"]
     *
     * Purpose: Vobiz's `media.track` field is the bare string "inbound"
     * or "outbound". Using the same values as Speechmatics channel labels
     * means routing is a direct lookup.
     */
    expect(CHANNELS).toEqual(["inbound", "outbound"]);
  });
});

describe("CallSession.enqueue", () => {
  function withStubbedClient() {
    /**
     * Build a CallSession with its internal RT client swapped for a
     * plain spy. We poke the private fields directly - this is a test
     * harness so escaping visibility is fine.
     *
     * `ready` is the flag the session sets once StartRecognition has been
     * acknowledged; a client alone is not enough to make sends safe, so
     * these tests set it to model an already-established session.
     */
    const session = new CallSession();
    const spies = {
      sendChannelAudio: vi.fn(),
      endChannel: vi.fn(),
      stopRecognition: vi.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).client = spies;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).ready = true;
    return { session, spies };
  }

  it("routes inbound frames to the inbound channel", () => {
    /**
     * Scenario: An inbound-track frame is routed correctly
     *   Given a CallSession with a stubbed RT client
     *    When enqueue("inbound", base64Payload) is called
     *    Then sendChannelAudio was called once with ("inbound", base64Payload)
     *
     * Purpose: routing invariant for one direction.
     */
    const { session, spies } = withStubbedClient();
    session.enqueue("inbound", "AAA=");
    expect(spies.sendChannelAudio).toHaveBeenCalledWith("inbound", "AAA=");
  });

  it("routes outbound frames to the outbound channel", () => {
    /**
     * Scenario: An outbound-track frame is routed correctly
     *   Given a CallSession with a stubbed RT client
     *    When enqueue("outbound", base64Payload) is called
     *    Then sendChannelAudio was called once with ("outbound", base64Payload)
     *
     * Purpose: mirror of the inbound test - routing must be symmetric.
     */
    const { session, spies } = withStubbedClient();
    session.enqueue("outbound", "BBB=");
    expect(spies.sendChannelAudio).toHaveBeenCalledWith("outbound", "BBB=");
  });

  it("silently drops frames with an unknown track", () => {
    /**
     * Scenario: A frame tagged with an unknown track label
     *   Given a CallSession with a stubbed RT client
     *    When enqueue("bogus", base64Payload) is called
     *    Then no exception is raised
     *     And sendChannelAudio is never called
     *
     * Purpose: defensive against malformed Vobiz messages or a future
     * protocol change that adds a new track name.
     */
    const { session, spies } = withStubbedClient();
    expect(() => session.enqueue("bogus", "XXX=")).not.toThrow();
    expect(spies.sendChannelAudio).not.toHaveBeenCalled();
  });

  it("ignores frames that arrive after close", async () => {
    /**
     * Scenario: A straggling frame after teardown
     *   Given a CallSession that has been closed
     *    When enqueue("inbound", ...) is called
     *    Then nothing is sent
     *
     * Purpose: the socket "close" handler and a last media event can race;
     * a closed session must not send on a finished RT session.
     */
    const { session, spies } = withStubbedClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).eotResolve?.();
    await session.close();
    session.enqueue("inbound", "late");
    expect(spies.sendChannelAudio).not.toHaveBeenCalled();
  });
});

describe("CallSession.enqueue - start-of-call race", () => {
  /**
   * Build the spy client without attaching it, so the session is in the
   * state it really occupies for the first few hundred milliseconds of a
   * call: constructed and started, but with no usable socket yet.
   */
  function stubClient() {
    return {
      sendChannelAudio: vi.fn(),
      endChannel: vi.fn(),
      stopRecognition: vi.fn().mockResolvedValue(undefined),
    };
  }

  /**
   * Promote a session to "ready" exactly the way run() does once
   * StartRecognition has been acknowledged: attach the client, flip the
   * flag, then flush the backlog.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function becomeReady(session: CallSession, spies: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).client = spies;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).ready = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).drainPending();
  }

  it("buffers frames that arrive before the session is ready, losing none", () => {
    /**
     * Scenario: Vobiz media arrives during the JWT fetch / RT handshake
     *   Given a CallSession whose RT client does not exist yet
     *    When five frames are enqueued on each track
     *    Then no frame reaches the client while it is unready
     *     And once the session becomes ready all ten are delivered
     *     And each channel receives its frames in arrival order
     *
     * Purpose: Vobiz sends its first media frame right after "start", but
     * createSpeechmaticsJWT() plus a TLS WebSocket handshake takes
     * hundreds of ms. This is the ../python/proxy.py AsyncQueueSource
     * guarantee - the queues exist from construction, so early audio waits
     * rather than evaporating.
     */
    const session = new CallSession();
    const spies = stubClient();

    for (let i = 0; i < 5; i += 1) {
      session.enqueue("inbound", `in${i}`);
      session.enqueue("outbound", `out${i}`);
    }

    // Nothing can have been sent - there is no socket to send on.
    expect(spies.sendChannelAudio).not.toHaveBeenCalled();

    becomeReady(session, spies);

    expect(spies.sendChannelAudio).toHaveBeenCalledTimes(10);
    const byChannel = (channel: string) =>
      spies.sendChannelAudio.mock.calls
        .filter((call: unknown[]) => call[0] === channel)
        .map((call: unknown[]) => call[1]);
    expect(byChannel("inbound")).toEqual(["in0", "in1", "in2", "in3", "in4"]);
    expect(byChannel("outbound")).toEqual(["out0", "out1", "out2", "out3", "out4"]);
  });

  it("keeps seq_no aligned with what was actually sent", async () => {
    /**
     * Scenario: EndOfChannel after a buffered start
     *   Given three inbound and one outbound frame buffered pre-readiness
     *    When the session becomes ready and is then closed
     *    Then endChannel reports last_seq_no 3 for inbound and 1 for outbound
     *
     * Purpose: close() passes seqNo as EndOfChannel.last_seq_no, which the
     * server uses to know when a channel is complete. A buffered frame
     * counted before delivery would leave the server waiting forever for
     * audio that never went out.
     */
    const session = new CallSession();
    const spies = stubClient();

    session.enqueue("inbound", "a");
    session.enqueue("inbound", "b");
    session.enqueue("inbound", "c");
    session.enqueue("outbound", "d");

    becomeReady(session, spies);

    // Resolve EndOfTranscript so close() skips its 10-second fallback.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).eotResolve?.();
    await session.close();

    expect(spies.endChannel).toHaveBeenCalledWith("inbound", 3);
    expect(spies.endChannel).toHaveBeenCalledWith("outbound", 1);
  });

  it("never throws when the socket rejects a frame", () => {
    /**
     * Scenario: The RT socket is still CONNECTING when a frame is sent
     *   Given a ready session whose client throws "WebSocket is not open"
     *    When a frame is enqueued
     *    Then enqueue() does not throw
     *     And the failure is reported on the console
     *
     * Purpose: enqueue() is called from inside ws's synchronous "message"
     * listener, so anything it throws bypasses the promise chain around
     * handleVobizCall and becomes an uncaught exception that takes the
     * whole process - and every concurrent call - down.
     */
    const session = new CallSession();
    const spies = stubClient();
    spies.sendChannelAudio.mockImplementation(() => {
      throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session as any).client = spies;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session as any).ready = true;

      expect(() => session.enqueue("inbound", "boom")).not.toThrow();
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("bounds the buffer and complains when it overflows", () => {
    /**
     * Scenario: A session that never connects keeps receiving audio
     *   Given a CallSession that never becomes ready
     *    When far more frames are enqueued than the per-channel cap
     *    Then the buffer stops growing at the cap
     *     And the overflow is reported on the console, not hidden
     *
     * Purpose: a hung RT connection must not turn into an unbounded memory
     * leak - L16 at 16 kHz is 32 KB/s/channel and a call can last hours.
     */
    const session = new CallSession();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      for (let i = 0; i < 1_000; i += 1) {
        session.enqueue("inbound", `f${i}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buffered: string[] = (session as any).pending.inbound;
      expect(buffered.length).toBeLessThan(1_000);
      expect(buffered[0]).toBe("f0");
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("CallSession.handleFinal", () => {
  it("prints the SDK's formatted transcript, not a space-joined results[]", () => {
    /**
     * Scenario: A final transcript containing punctuation results
     *   Given an AddTranscript whose metadata.transcript is already formatted
     *    When the session handles it
     *    Then the console shows "Hello there. How are you?"
     *     And there is no space before the full stop or question mark
     *
     * Purpose: punctuation arrives as its own result, so joining results[]
     * on " " prints "Hello there . How are you ?".
     */
    const session = new CallSession();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session as any).handleFinal({
        channel: "inbound",
        metadata: { transcript: "Hello there. How are you?" },
        results: [
          { type: "word", alternatives: [{ content: "Hello" }] },
          { type: "word", alternatives: [{ content: "there" }] },
          { type: "punctuation", alternatives: [{ content: "." }] },
          { type: "word", alternatives: [{ content: "How" }] },
          { type: "word", alternatives: [{ content: "are" }] },
          { type: "word", alternatives: [{ content: "you" }] },
          { type: "punctuation", alternatives: [{ content: "?" }] },
        ],
      });

      const printed = write.mock.calls.map((call) => String(call[0])).join("");
      expect(printed).toContain("Hello there. How are you?");
      expect(printed).not.toContain(" .");
      expect(printed).not.toContain(" ?");
    } finally {
      write.mockRestore();
    }
  });

  it("continues one channel on one line and starts a new line on a speaker change", () => {
    /**
     * Scenario: Finals alternate between the two channels
     *   Given finals inbound, inbound, outbound, then an empty final
     *    When the session handles them
     *    Then inbound's two chunks share a line under "[inbound ]"
     *     And outbound starts a new line under "[outbound]"
     *     And the empty final prints nothing
     *
     * Purpose: the console layout documented in the README.
     */
    const session = new CallSession();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = session as any;
      s.handleFinal({ channel: "inbound", metadata: { transcript: "Hello. " } });
      s.handleFinal({ channel: "inbound", metadata: { transcript: "Can you hear me? " } });
      s.handleFinal({ channel: "outbound", metadata: { transcript: "Yes. " } });
      s.handleFinal({ channel: "outbound", metadata: { transcript: "" } });

      const printed = write.mock.calls.map((call) => String(call[0])).join("");
      expect(printed).toBe("[inbound ] Hello. Can you hear me? \n[outbound] Yes. ");
    } finally {
      write.mockRestore();
    }
  });
});

describe("CallSession.handleFinal - consecutive finals", () => {
  it("does not add a second space between finals on the same channel", () => {
    /**
     * Scenario: Several finals arrive in a row on one channel
     *   Given AddTranscript chunks whose metadata.transcript each end in a
     *         trailing space, as the server sends them
     *    When the session handles them back to back
     *    Then the line reads "This call is being transcribed " with single
     *         spaces between words
     *
     * Purpose: the chunks are built for plain concatenation. Adding our
     * own separator on top printed "This call  is  being  transcribed".
     */
    const session = new CallSession();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      for (const transcript of ["This call ", "is ", "being ", "transcribed "]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (session as any).handleFinal({ channel: "outbound", metadata: { transcript } });
      }

      const printed = write.mock.calls.map((call) => String(call[0])).join("");
      expect(printed).toBe("[outbound] This call is being transcribed ");
      expect(printed).not.toMatch(/\S {2,}\S/);
    } finally {
      write.mockRestore();
    }
  });
});

describe("CallSession.close", () => {
  function stubbedSession() {
    const session = new CallSession();
    const spies = {
      sendChannelAudio: vi.fn(),
      endChannel: vi.fn(),
      stopRecognition: vi.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).client = spies;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).ready = true;
    return { session, spies };
  }

  it("sends EndOfChannel for each channel then stops recognition", async () => {
    /**
     * Scenario: Graceful close cascades to the RT client
     *   Given a CallSession with a stubbed RT client and some enqueued frames
     *    When close() is awaited
     *    Then endChannel is called once for each channel with its seq_no
     *     And stopRecognition is called
     *
     * Purpose: Vobiz signals the end of a call only by closing the socket,
     * so this is the one teardown path. The RT server must learn each
     * channel is done so it can flush the last finals.
     */
    const { session, spies } = stubbedSession();

    session.enqueue("inbound", "A");
    session.enqueue("inbound", "B");
    session.enqueue("outbound", "C");

    // Resolve EndOfTranscript so close() doesn't wait the 10 s fallback.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).eotResolve?.();

    await session.close();

    expect(spies.endChannel).toHaveBeenCalledWith("inbound", 2);
    expect(spies.endChannel).toHaveBeenCalledWith("outbound", 1);
    expect(spies.stopRecognition).toHaveBeenCalled();
  });

  it("is idempotent on repeated calls", async () => {
    /**
     * Scenario: close() called twice
     *   Given a CallSession that has already been closed
     *    When close() is awaited a second time
     *    Then endChannel/stopRecognition are not called again
     *
     * Purpose: the ws "close" and "error" events can both fire for one
     * socket - double-closing must be safe.
     */
    const { session, spies } = stubbedSession();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).eotResolve?.();

    await session.close();
    spies.endChannel.mockClear();
    spies.stopRecognition.mockClear();
    await session.close();

    expect(spies.endChannel).not.toHaveBeenCalled();
    expect(spies.stopRecognition).not.toHaveBeenCalled();
  });

  it("says so when EndOfTranscript never arrives", async () => {
    /**
     * Scenario: The server never acknowledges the end of the channels
     *   Given a session whose EndOfTranscript never comes
     *    When close() runs past its 10 s wait
     *    Then "Timed out waiting for END_OF_TRANSCRIPT" is logged
     *     And recognition is still stopped
     *
     * Purpose: matches the Python proxy; a silent 10 s stall at hang-up
     * looks like a hung process.
     */
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { session, spies } = stubbedSession();
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(10_000);
      await closing;
      expect(errorLog.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        "Timed out waiting for END_OF_TRANSCRIPT",
      );
      expect(spies.stopRecognition).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      errorLog.mockRestore();
      write.mockRestore();
    }
  });
});
