/**
 * Vobiz Voice <-> Speechmatics Realtime proxy server (multi-channel).
 *
 * Node.js/TypeScript sibling of ../python/proxy.py. Bridges a Vobiz audio
 * stream to Speechmatics' Realtime API using channel diarization. The answer
 * XML forks the call with `audioTrack="both"`, so each call produces two
 * per-speaker transcript streams (inbound / outbound), transcribed via a
 * single Speechmatics RT multi-channel session.
 *
 * Run:
 *     npm start                    # wait for an inbound call
 *     npm start -- --call +E164    # have Vobiz place an outbound call
 *
 * The server listens on localhost:<PORT> and, on startup, opens an ngrok
 * tunnel (or uses PUBLIC_URL) and points the configured Vobiz number at the
 * tunnel's /answer endpoint through a Vobiz application. Dial the Vobiz
 * number to trigger a call.
 *
 * Environment variables (loaded from ../.env):
 *   SPEECHMATICS_API_KEY   Speechmatics Realtime API key.
 *   NGROK_AUTHTOKEN        ngrok auth token (not needed with PUBLIC_URL).
 *   VOBIZ_AUTH_ID          Vobiz Auth ID (MA_...).
 *   VOBIZ_AUTH_TOKEN       Vobiz Auth Token.
 *   VOBIZ_PHONE_NUMBER     E.164 Vobiz number to auto-configure.
 *   FORWARD_TO_NUMBER      E.164 number the <Dial> bridges to.
 *   SPEECHMATICS_LANGUAGE  Optional. Transcription language. Default: en.
 *   SM_VOBIZ_PROXY_PORT    Optional. Local server port. Default: 5000.
 *   PUBLIC_URL             Optional. https:// URL of a tunnel you already
 *                          run to this port; replaces ngrok.
 */

import http from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";

import dotenv from "dotenv";
import ngrok from "@ngrok/ngrok";
import { WebSocketServer, type WebSocket } from "ws";
import { createSpeechmaticsJWT } from "@speechmatics/auth";
import {
  RealtimeClient,
  type AddChannelAudio,
  type EndOfChannel,
  type RealtimeClientMessage,
  type RealtimeTranscriptionConfig,
} from "@speechmatics/real-time-client";

// Load ../.env so JS and Python demos can share the same secrets file.
// Skipped under Vitest so the suite never reads real credentials and
// "missing env var" tests can't be masked by a developer's .env.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.VITEST) {
  dotenv.config({ path: path.join(__dirname, "..", ".env") });
}

// ─────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────

const SM_API_KEY = process.env.SPEECHMATICS_API_KEY;
const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN;
const VOBIZ_AUTH_ID = process.env.VOBIZ_AUTH_ID;
const VOBIZ_AUTH_TOKEN = process.env.VOBIZ_AUTH_TOKEN;
const VOBIZ_PHONE_NUMBER = process.env.VOBIZ_PHONE_NUMBER;
const FORWARD_TO_NUMBER = process.env.FORWARD_TO_NUMBER;
const PUBLIC_URL = process.env.PUBLIC_URL;
const PORT = Number.parseInt(process.env.SM_VOBIZ_PROXY_PORT ?? "5000", 10);
const LANGUAGE = process.env.SPEECHMATICS_LANGUAGE || "en";

export const VOBIZ_API_BASE = "https://api.vobiz.ai/api/v1";
const VOBIZ_APP_PREFIX = "speechmatics-transcription";

const REQUIRED_ENV_VARS = [
  "SPEECHMATICS_API_KEY",
  "NGROK_AUTHTOKEN",
  "VOBIZ_AUTH_ID",
  "VOBIZ_AUTH_TOKEN",
  "VOBIZ_PHONE_NUMBER",
  "FORWARD_TO_NUMBER",
] as const;

// The answer XML asks Vobiz for 16-bit linear PCM at 16 kHz, in 20 ms
// frames (640 bytes each), base64-encoded inside JSON. Speechmatics
// Realtime accepts this natively, so frames are forwarded without
// transcoding.
export const VOBIZ_CONTENT_TYPE = "audio/x-l16;rate=16000";

export interface AudioFormat {
  encoding: "pcm_s16le" | "mulaw";
  sample_rate: number;
  // Bytes in one 20 ms Vobiz frame. Informational in JS: the SDK sends each
  // frame as its own AddChannelAudio message, so no re-chunking happens.
  chunk_size: number;
}

export const VOBIZ_AUDIO_FORMAT: AudioFormat = {
  encoding: "pcm_s16le",
  sample_rate: 16000,
  chunk_size: 640,
};

// Vobiz reports the format it actually sends in `start.mediaFormat`.
const SUPPORTED_MEDIA_FORMATS: Record<string, AudioFormat> = {
  "audio/x-l16/16000": VOBIZ_AUDIO_FORMAT,
  "audio/x-l16/8000": { encoding: "pcm_s16le", sample_rate: 8000, chunk_size: 320 },
  "audio/x-mulaw/8000": { encoding: "mulaw", sample_rate: 8000, chunk_size: 160 },
};

// The channel IDs we register with Speechmatics match Vobiz's own track
// labels so routing is a direct lookup - no translation table needed.
export const CHANNELS = ["inbound", "outbound"] as const;
export type Channel = (typeof CHANNELS)[number];

// Vobiz starts shipping media right after the "start" event, but fetching
// a JWT and completing the Speechmatics WebSocket handshake takes hundreds
// of milliseconds. Frames that arrive in that gap are buffered per channel
// (see CallSession.enqueue) and flushed once the session is ready.
//
// Cap: frames are 20 ms whatever the format, so 750 frames is 15 s of
// audio - comfortably longer than any start-up race the SDK can still win
// (it abandons StartRecognition after a 10 s timeout) while bounding a
// session that never connects to ~640 KB of base64 per channel at L16/16 kHz
// instead of unbounded growth for the life of the socket.
const MAX_BUFFERED_FRAMES_PER_CHANNEL = 750;

// ─────────────────────────────────────────────────────────────────────
// Env validation
// ─────────────────────────────────────────────────────────────────────

export function checkEnvVars(): void {
  let missing: string[] = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (PUBLIC_URL) {
    // An existing tunnel replaces ngrok.
    missing = missing.filter((name) => name !== "NGROK_AUTHTOKEN");
  }
  if (missing.length > 0) {
    console.error(`Missing required env vars in .env: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (PUBLIC_URL && !PUBLIC_URL.startsWith("https://")) {
    console.error(
      `PUBLIC_URL must start with https:// (got ${PUBLIC_URL}). Vobiz fetches ` +
        `/answer over https and opens the audio stream over wss.`,
    );
    process.exit(1);
  }
}

/**
 * Prove the Speechmatics key works before anything else is set up.
 *
 * Without this, a bad key only surfaces on the first call - after ngrok is
 * up and the Vobiz number has been repointed - so everything looks healthy
 * except the one thing that matters. Minting a token is the same request
 * that fails for an invalid key at call time, so it is a faithful check.
 * The token is discarded; each call mints its own.
 */
export async function checkSpeechmaticsKey(): Promise<void> {
  try {
    await createSpeechmaticsJWT({ type: "rt", apiKey: SM_API_KEY as string, ttl: 60 });
  } catch (err) {
    console.error(
      `Could not authenticate with Speechmatics: ${err instanceof Error ? err.message : String(err)}\n` +
        `Check SPEECHMATICS_API_KEY in .env (and that mp.speechmatics.com is reachable). ` +
        `Nothing has been started and your Vobiz number has not been changed.`,
    );
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────
// MultiChannelRealtimeClient
//
// The JS SDK's RealtimeClient exposes sendAudio(binary) for single-channel
// raw audio, but no public sendChannelAudio(channel, base64). The
// multi-channel protocol *is* fully supported by the server - we just have
// to construct AddChannelAudio JSON messages ourselves. The SDK's own
// sendMessage() is private, so this subclass provides thin, typed helpers.
// ─────────────────────────────────────────────────────────────────────

interface PrivateSend {
  sendMessage(msg: RealtimeClientMessage): void;
}

class MultiChannelRealtimeClient extends RealtimeClient {
  sendChannelAudio(channel: string, base64Data: string): void {
    const msg: AddChannelAudio = {
      message: "AddChannelAudio",
      channel,
      data: base64Data,
    };
    (this as unknown as PrivateSend).sendMessage(msg);
  }

  endChannel(channel: string, lastSeqNo: number): void {
    const msg: EndOfChannel = {
      message: "EndOfChannel",
      channel,
      last_seq_no: lastSeqNo,
    };
    (this as unknown as PrivateSend).sendMessage(msg);
  }
}

// ─────────────────────────────────────────────────────────────────────
// CallSession - one Speechmatics session covering both Vobiz tracks
// ─────────────────────────────────────────────────────────────────────

export class CallSession {
  private client: MultiChannelRealtimeClient | null = null;
  private closed = false;
  private lastFinalChannel: string | null = null;
  private readonly seqNo: Record<Channel, number> = { inbound: 0, outbound: 0 };
  private startPromise: Promise<void> | null = null;
  private eotResolve: (() => void) | null = null;
  private readonly eotPromise: Promise<void>;

  // Per-channel FIFO of base64 frames that arrived before the RT socket was
  // usable. These queues exist from construction - the same property that
  // makes ../python/proxy.py immune, where AsyncQueueSource is built in
  // CallSession.__init__ and buffers until the SDK's reader drains it.
  private readonly pending: Record<Channel, string[]> = { inbound: [], outbound: [] };

  // True only between RecognitionStarted and the socket closing: the one
  // window in which sendChannelAudio() is guaranteed not to throw.
  private ready = false;

  // Latched when the session can never become usable (connect/start failed,
  // socket closed, or a send threw). Further frames are dropped, loudly,
  // rather than buffered forever.
  private failed = false;

  private readonly dropped: Record<Channel, number> = { inbound: 0, outbound: 0 };

  constructor(readonly audioFormat: AudioFormat = VOBIZ_AUDIO_FORMAT) {
    // Track EndOfTranscript arrival so close() can wait for the server
    // to flush any final results before disconnecting.
    this.eotPromise = new Promise<void>((resolve) => {
      this.eotResolve = resolve;
    });
  }

  /** Kick off the Speechmatics RT connection. Non-blocking. */
  start(): void {
    this.startPromise = this.run();
  }

  /**
   * Route a base64-encoded audio frame from Vobiz to Speechmatics.
   *
   * Never throws, and never drops a frame merely for being early. Vobiz's
   * first media frame lands right after "start", long before the JWT fetch
   * and WebSocket handshake finish, so anything arriving before the session
   * is ready is queued and flushed in order by drainPending(). Sending
   * eagerly instead would throw "WebSocket is not open: readyState 0
   * (CONNECTING)" from inside a ws listener and take the process down.
   */
  enqueue(track: string, base64Payload: string): void {
    if (this.closed || !this.isKnownChannel(track)) {
      return;
    }
    if (this.ready) {
      // A frame the socket refuses is still a frame lost - count it, so
      // close()'s tally reflects every gap in the transcript.
      if (!this.sendFrame(track, base64Payload)) {
        this.dropped[track] += 1;
      }
      return;
    }
    if (this.failed || this.pending[track].length >= MAX_BUFFERED_FRAMES_PER_CHANNEL) {
      this.noteDrop(track);
      return;
    }
    this.pending[track].push(base64Payload);
  }

  /**
   * Cleanly shut down the RT session: EndOfChannel per track, wait for
   * EndOfTranscript so any last finals print, then disconnect.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Let the start sequence settle before tearing down. On a very short
    // call the socket may still be coming up with frames queued behind it;
    // EndOfChannel has to follow that audio, not precede it. This mirrors
    // python's close(), which signals EOF on the queues and then awaits the
    // reader task. Bounded by the SDK's 10 s StartRecognition timeout.
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }

    if (this.client) {
      // Anything still queued goes out now, before the seq_no below is read.
      this.drainPending();

      for (const channel of CHANNELS) {
        try {
          this.client.endChannel(channel, this.seqNo[channel]);
        } catch {
          // Socket may already be closed - non-fatal.
        }
      }

      // Wait up to 10s for the server to flush the last transcripts
      // (EndOfTranscript arrives after all EndOfChannel are ack'd).
      let timer: NodeJS.Timeout | undefined;
      const gotEot = await Promise.race([
        this.eotPromise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
      clearTimeout(timer);
      if (!gotEot) {
        console.error("Timed out waiting for END_OF_TRANSCRIPT");
      }

      try {
        await this.client.stopRecognition({ noTimeout: true });
      } catch {
        // Already-closed sockets throw; safe to swallow on teardown.
      }

      process.stdout.write("\n");
    }

    const lost = this.dropped.inbound + this.dropped.outbound;
    if (lost > 0) {
      console.error(
        `[speechmatics] call ended having dropped ${lost} audio frame(s) ` +
          `(inbound=${this.dropped.inbound}, outbound=${this.dropped.outbound}).`,
      );
    }
  }

  private isKnownChannel(track: string): track is Channel {
    return (CHANNELS as readonly string[]).includes(track);
  }

  /**
   * Send one frame and advance that channel's sequence counter.
   *
   * seqNo counts frames the server has actually been *sent*, not frames
   * received from Vobiz, because close() passes it as
   * EndOfChannel.last_seq_no - counting buffered-but-unsent or dropped
   * frames would leave the server waiting for audio that never arrives.
   *
   * Returns false (rather than throwing) if the socket rejected the frame:
   * callers run inside a ws "message" listener, where a throw escapes the
   * promise chain and becomes a fatal uncaught exception.
   */
  private sendFrame(channel: Channel, base64Payload: string): boolean {
    try {
      this.client?.sendChannelAudio(channel, base64Payload);
      this.seqNo[channel] += 1;
      return true;
    } catch (err) {
      this.ready = false;
      this.failed = true;
      console.error(
        `[speechmatics] ${channel}: send failed, abandoning audio for this call - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * Deliver every buffered frame in arrival order, or account for whatever
   * cannot be delivered. Deliberately synchronous: no await between two
   * frames means a concurrent enqueue() can never interleave itself into
   * the middle of a flush, so per-channel ordering holds exactly.
   */
  private drainPending(): void {
    for (const channel of CHANNELS) {
      const queue = this.pending[channel];
      this.pending[channel] = [];

      let sent = 0;
      while (sent < queue.length && this.ready && this.sendFrame(channel, queue[sent])) {
        sent += 1;
      }
      if (sent > 0) {
        console.log(`[speechmatics] ${channel}: flushed ${sent} buffered frame(s)`);
      }
      for (let i = sent; i < queue.length; i += 1) {
        this.noteDrop(channel);
      }
    }
  }

  /**
   * Count a dropped frame, shouting once per channel. At 50 frames/s a
   * per-frame log would bury every other line in the console, but silence
   * would hide real audio loss - so the first drop is loud and the total
   * is reported again by close().
   */
  private noteDrop(channel: Channel): void {
    this.dropped[channel] += 1;
    if (this.dropped[channel] === 1) {
      console.error(
        `[speechmatics] ${channel}: dropping audio - session unusable or buffer full ` +
          `(${MAX_BUFFERED_FRAMES_PER_CHANNEL} frames / ` +
          `${(MAX_BUFFERED_FRAMES_PER_CHANNEL * 20) / 1000}s). ` +
          `Transcripts for this call will have gaps.`,
      );
    }
  }

  private async run(): Promise<void> {
    let jwt: string;
    try {
      if (!SM_API_KEY) throw new Error("SPEECHMATICS_API_KEY missing at runtime");
      jwt = await createSpeechmaticsJWT({
        type: "rt",
        apiKey: SM_API_KEY,
        ttl: 60,
      });
    } catch (err) {
      // start() is fire-and-forget and nothing awaits startPromise until
      // close(), so a throw here would be an unhandled rejection and kill
      // the process - and every other call in flight with it. Fail this
      // call only, and say what to check: the SDK's own message for a bad
      // key ("Failed to parse JSON response") does not.
      this.failed = true;
      if (!this.closed) {
        console.error(
          `Speechmatics auth error: ${err instanceof Error ? err.message : String(err)}. ` +
            `Check SPEECHMATICS_API_KEY. Audio for this call will not be transcribed.`,
        );
      }
      // Account for any frames already buffered; there is no session to send them to.
      this.drainPending();
      return;
    }

    this.client = new MultiChannelRealtimeClient();

    // The SDK dispatches socketStateChange when the socket is created, on
    // error and on close - but *not* on open (see the RealtimeClient
    // constructor in the installed SDK). It is therefore only useful as a
    // "stop sending" signal; readiness comes from start() resolving below.
    this.client.addEventListener("socketStateChange", ({ socketState }) => {
      if (socketState === "closing" || socketState === "closed") {
        this.ready = false;
        this.failed = true;
      }
    });

    this.client.addEventListener("receiveMessage", ({ data }) => {
      if (data.message === "EndOfTranscript") {
        this.eotResolve?.();
        return;
      }
      if (data.message === "AddPartialTranscript") {
        // Stub - wire partials here if you want to render them (live UI,
        // LLM prompt, agent-assist, etc.). Example:
        //   const text = data.metadata.transcript;
        //   const channel = data.channel ?? "?";
        return;
      }
      if (data.message === "AddTranscript") {
        this.handleFinal(data);
        return;
      }
      if (data.message === "Error") {
        console.error(`Speechmatics error: ${data.type} - ${data.reason ?? ""}`);
      }
    });

    const startMsg: RealtimeTranscriptionConfig = {
      transcription_config: {
        language: LANGUAGE,
        max_delay: 0.7,
        // Asks the server to send AddPartialTranscript. The handler above is
        // a deliberate stub - how to use partials (live UI, agent-assist,
        // LLM prompt) is up to whoever adapts this. Set to false if you
        // don't wire them in, to save the extra messages.
        enable_partials: true,
        model: "enhanced",
        diarization: "channel",
        channel_diarization_labels: [...CHANNELS],
      },
      // The format Vobiz reported in start.mediaFormat, so the bytes are
      // interpreted exactly as they were encoded.
      audio_format: {
        type: "raw",
        encoding: this.audioFormat.encoding,
        sample_rate: this.audioFormat.sample_rate,
      },
    };

    try {
      // start() resolves only once the server answers StartRecognition with
      // RecognitionStarted, which means the socket is OPEN and the session
      // is configured. That is the SDK's only trustworthy readiness signal,
      // so it is the moment we unlock direct sends and flush the backlog.
      await this.client.start(jwt, startMsg);
      this.ready = true;
      this.drainPending();
    } catch (err) {
      this.ready = false;
      this.failed = true;
      if (!this.closed) {
        console.error(
          `Speechmatics session error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Account for the backlog we will never be able to send.
      this.drainPending();
    }
  }

  private handleFinal(msg: { metadata: { transcript: string }; channel?: string }): void {
    // metadata.transcript is the SDK's pre-formatted text. Joining results[]
    // by hand would put a space before every punctuation result ("today ?").
    // It is built for concatenation: each chunk already carries its own
    // trailing space, so consecutive chunks are appended with no separator.
    const text = msg.metadata.transcript;
    if (!text) return;

    const channel = msg.channel ?? "?";
    const label = `[${channel.padEnd(8)}]`;

    if (this.lastFinalChannel === null) {
      process.stdout.write(`${label} ${text}`);
    } else if (channel !== this.lastFinalChannel) {
      process.stdout.write(`\n${label} ${text}`);
    } else {
      process.stdout.write(text);
    }
    this.lastFinalChannel = channel;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Vobiz audio stream WebSocket handler
// ─────────────────────────────────────────────────────────────────────

interface VobizStreamEvent {
  event: string;
  start?: {
    streamId?: string;
    callId?: string;
    tracks?: string[];
    mediaFormat?: { encoding?: string; sampleRate?: number };
  };
  media?: {
    track?: string;
    payload?: string;
  };
}

/** Map Vobiz's `start.mediaFormat` to the audio format Speechmatics is given. */
export function audioFormatFor(mediaFormat: {
  encoding?: string;
  sampleRate?: number;
}): AudioFormat | null {
  return SUPPORTED_MEDIA_FORMATS[`${mediaFormat.encoding}/${mediaFormat.sampleRate}`] ?? null;
}

// Strict base64: the payload is forwarded without decoding, so it is checked
// here instead - a malformed frame costs one frame, not the session.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_RE.test(value);
}

export async function handleVobizCall(ws: WebSocket): Promise<void> {
  // Wrap the session in an object so TypeScript's control-flow analysis
  // doesn't wrongly infer "never assigned" from the outer scope - reads
  // via `.session` correctly narrow after the callback mutates it.
  const state: { session: CallSession | null; streamId?: string; badFrames: number } = {
    session: null,
    badFrames: 0,
  };

  // Vobiz sends no "stop" event: the socket closing is the end of the call.
  const closed = new Promise<void>((resolve) => {
    ws.on("close", () => resolve());
    ws.on("error", () => resolve());
  });

  ws.on("message", (raw: Buffer) => {
    let message: VobizStreamEvent;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    // This listener is invoked synchronously by ws's event emitter, so a
    // throw in here does NOT reach the .catch() on handleVobizCall's
    // promise - it becomes an uncaught exception and kills the process,
    // dropping every other call in flight. One bad event must cost us that
    // event only, so the whole body is guarded and the error is logged
    // rather than swallowed.
    try {
      switch (message.event) {
        case "start": {
          const start = message.start ?? {};
          const mediaFormat = start.mediaFormat ?? {};
          state.streamId = start.streamId;
          console.log(
            `[vobiz] call started - stream=${state.streamId} call=${start.callId} ` +
              `tracks=${JSON.stringify(start.tracks)} ` +
              `format=${mediaFormat.encoding}/${mediaFormat.sampleRate}`,
          );
          const audioFormat = audioFormatFor(mediaFormat);
          if (!audioFormat) {
            console.error(
              `[vobiz] unsupported audio format ${JSON.stringify(mediaFormat)}; ` +
                `this call will not be transcribed`,
            );
            break;
          }
          state.session = new CallSession(audioFormat);
          state.session.start();
          break;
        }
        case "media": {
          const payload = message.media?.payload;
          if (!state.session || !payload) return;
          if (!isBase64(payload)) {
            state.badFrames += 1;
            if (state.badFrames === 1) {
              console.error(
                `[vobiz] dropping undecodable audio frame (invalid base64); ` +
                  `further bad frames are counted, not logged`,
              );
            }
            return;
          }
          // Vobiz labels each frame "inbound" (caller) or "outbound" (callee).
          // Base64 pass-through: the payload feeds AddChannelAudio.data as-is.
          state.session.enqueue(message.media?.track ?? "inbound", payload);
          break;
        }
      }
    } catch (err) {
      console.error(
        `[vobiz] error handling "${message.event}" event: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });

  await closed;
  if (state.badFrames > 0) {
    console.error(
      `[vobiz] dropped ${state.badFrames} undecodable audio frame(s) (stream=${state.streamId})`,
    );
  }
  if (state.session) {
    await state.session.close();
  }
  console.log(`[vobiz] call ended (stream=${state.streamId})`);
}

// ─────────────────────────────────────────────────────────────────────
// ngrok tunnel + answer XML + Vobiz number configuration
// ─────────────────────────────────────────────────────────────────────

async function startNgrokTunnel(): Promise<string> {
  const listener = await ngrok.forward({
    addr: PORT,
    authtoken: NGROK_AUTHTOKEN,
    proto: "http",
  });
  const url = listener.url();
  if (!url) throw new Error("ngrok tunnel returned no URL");
  return url;
}

/** Use PUBLIC_URL if you already run a tunnel, otherwise open ngrok. */
async function publicBaseUrl(): Promise<string> {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/+$/, "");
  return startNgrokTunnel();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Build the VobizXML that Vobiz fetches when a call comes in.
 *
 * A one-way <Stream> does not block, so Vobiz moves straight on to <Speak>
 * and <Dial> while it keeps forking both sides of the call to the proxy.
 */
export function buildAnswerXml(streamUrl: string, forwardTo: string, callerId: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response>" +
    `<Stream audioTrack="both" contentType="${VOBIZ_CONTENT_TYPE}">` +
    `${escapeXml(streamUrl)}</Stream>` +
    "<Speak>This call is being transcribed.</Speak>" +
    `<Dial callerId="${escapeXml(callerId)}" timeout="30"><Number>${escapeXml(forwardTo)}</Number></Dial>` +
    "</Response>"
  );
}

/** Any failure talking to the Vobiz REST API, already worded for the console. */
export class VobizApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VobizApiError";
  }
}

type Json = Record<string, unknown>;

/** Call the Vobiz REST API and return the decoded JSON response. */
export async function vobizRequest(method: string, apiPath: string, body?: Json): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(`${VOBIZ_API_BASE}/Account/${VOBIZ_AUTH_ID}${apiPath}`, {
      method,
      headers: {
        "X-Auth-ID": VOBIZ_AUTH_ID ?? "",
        "X-Auth-Token": VOBIZ_AUTH_TOKEN ?? "",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // DNS failure, refused connection, TLS error or the 15 s timeout.
    throw new VobizApiError(
      `Vobiz API ${method} ${apiPath} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new VobizApiError(
      `Vobiz API ${method} ${apiPath} failed reading the response: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!response.ok) {
    throw new VobizApiError(
      `Vobiz API ${method} ${apiPath} returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed as Json;
  } catch {
    throw new VobizApiError(
      `Vobiz API ${method} ${apiPath} returned a non-JSON body: ${text.slice(0, 300)}`,
    );
  }
}

/** One application per number, so two numbers on one account don't fight. */
export function appNameFor(phoneNumber: string): string {
  return `${VOBIZ_APP_PREFIX}-${phoneNumber.replace(/\D/g, "")}`;
}

interface VobizApp {
  app_id?: string;
  app_name?: string;
}

/** Page through the account's applications until `name` turns up. */
async function findApp(name: string): Promise<VobizApp | null> {
  const limit = 100;
  let offset = 0;
  for (;;) {
    const page = await vobizRequest("GET", `/Application/?limit=${limit}&offset=${offset}`);
    const objects = (Array.isArray(page.objects) ? page.objects : []) as VobizApp[];
    const match = objects.find((a) => a.app_name === name);
    if (match) return match;

    const meta = (page.meta ?? {}) as { next?: string | null; total_count?: number };
    offset += limit;
    if (!meta.next || objects.length === 0) return null;
    if (typeof meta.total_count === "number" && offset >= meta.total_count) return null;
  }
}

/**
 * Route the Vobiz number to our /answer endpoint.
 *
 * Creates (or updates) a Vobiz application named appNameFor(number) and
 * attaches the number to it. Returns the app_id the number was attached
 * to before, so the operator can switch it back.
 */
export async function pointVobizNumber(answerUrl: string, hangupUrl: string): Promise<string | null> {
  const phoneNumber = VOBIZ_PHONE_NUMBER ?? "";
  const encoded = encodeURIComponent(phoneNumber);
  const found = await vobizRequest("GET", `/numbers?search=${encoded}`);
  const numbers = (Array.isArray(found.items) ? found.items : []) as {
    e164?: string;
    application_id?: string | null;
  }[];
  const number = numbers.find((n) => n.e164 === phoneNumber);
  if (!number) {
    console.error(`Vobiz number ${phoneNumber} not found on this account.`);
    process.exit(1);
  }
  const previousApp = number.application_id || null;

  const appName = appNameFor(phoneNumber);
  const appFields = {
    answer_url: answerUrl,
    answer_method: "GET",
    hangup_url: hangupUrl,
    hangup_method: "GET",
  };
  const app = await findApp(appName);
  let appId: string;
  if (!app?.app_id) {
    const created = await vobizRequest("POST", "/Application/", { app_name: appName, ...appFields });
    if (typeof created.app_id !== "string" || !created.app_id) {
      throw new VobizApiError(
        `Vobiz API POST /Application/ returned no app_id: ${JSON.stringify(created).slice(0, 300)}`,
      );
    }
    appId = created.app_id;
  } else {
    appId = app.app_id;
    await vobizRequest("POST", `/Application/${appId}/`, appFields);
  }

  await vobizRequest("POST", `/numbers/${encoded}/application`, { application_id: appId });
  return previousApp !== appId ? previousApp : null;
}

/**
 * Have Vobiz call `to` from the Vobiz number; returns the request UUID.
 *
 * When `to` answers, Vobiz fetches the same answer XML as an inbound call,
 * so the call is forked to the proxy and bridged to FORWARD_TO_NUMBER.
 */
export async function placeOutboundCall(to: string, answerUrl: string, hangupUrl: string): Promise<string> {
  const response = await vobizRequest("POST", "/Call/", {
    from: VOBIZ_PHONE_NUMBER,
    to,
    answer_url: answerUrl,
    answer_method: "GET",
    hangup_url: hangupUrl,
    hangup_method: "GET",
  });
  return typeof response.request_uuid === "string" ? response.request_uuid : "";
}

// ─────────────────────────────────────────────────────────────────────
// Command line + request routing
// ─────────────────────────────────────────────────────────────────────

const USAGE =
  "usage: npm start [-- --call NUMBER]\n\n" +
  "  --call NUMBER  place an outbound call to this E.164 number instead of\n" +
  "                 waiting for an inbound call; it is bridged to\n" +
  "                 FORWARD_TO_NUMBER on answer";

export function parseCliArgs(argv: string[]): { call?: string } {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { call: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      console.log(USAGE);
      process.exit(0);
    }
    return { call: values.call };
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    process.exit(2);
  }
}

export interface Routes {
  answerPath: string;
  hangupPath: string;
  streamPath: string;
  answerBody: string;
}

export interface RouteResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function routeOf(url: string | undefined): string {
  return (url ?? "/").split("?", 1)[0];
}

/** True when an upgrade request is for this run's audio stream. */
export function isStreamRequest(url: string | undefined, routes: Routes): boolean {
  return routeOf(url) === routes.streamPath;
}

/**
 * Answer a plain HTTP request. Only this run's tokenised /answer and
 * /hangup paths exist; everything else is a 404, so a guessed path learns
 * nothing about the call.
 */
export function routeRequest(method: string | undefined, url: string | undefined, routes: Routes): RouteResult {
  const route = routeOf(url);
  const empty = (status: number, extra: Record<string, string> = {}): RouteResult => ({
    status,
    headers: { "Content-Length": "0", ...extra },
    body: "",
  });

  if (route === routes.answerPath || route === routes.hangupPath) {
    if (method !== "GET") return empty(405, { Allow: "GET" });
    if (route === routes.hangupPath) return empty(200);
    return {
      status: 200,
      headers: {
        "Content-Type": "application/xml",
        "Content-Length": Buffer.byteLength(routes.answerBody).toString(),
      },
      body: routes.answerBody,
    };
  }
  if (route === routes.streamPath) return empty(426, { Upgrade: "websocket" });
  return empty(404);
}

// ─────────────────────────────────────────────────────────────────────
// HTTP + WS server
// ─────────────────────────────────────────────────────────────────────

function fail(prefix: string, err: unknown): never {
  console.error(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

/**
 * Everything main() does before it waits for Ctrl-C. Returns the listening
 * server so tests can inspect and close it.
 */
export async function startProxy(argv: string[]): Promise<http.Server> {
  const args = parseCliArgs(argv);
  checkEnvVars();
  // Before ngrok and before the Vobiz number is repointed, so a bad key
  // fails here rather than on the first call.
  await checkSpeechmaticsKey();

  // A random path segment keeps the answer XML and audio socket private to
  // this run: the stream WebSocket is unsigned, and Vobiz only signs HTTP
  // callbacks when callback credentials are configured.
  const token = randomBytes(16).toString("base64url");
  const baseUrl = await publicBaseUrl();
  const routes: Routes = {
    answerPath: `/answer/${token}`,
    hangupPath: `/hangup/${token}`,
    streamPath: `/vobiz/${token}`,
    answerBody: "",
  };
  const wssUrl = baseUrl.replace(/^https:/, "wss:") + routes.streamPath;
  routes.answerBody = buildAnswerXml(wssUrl, FORWARD_TO_NUMBER as string, VOBIZ_PHONE_NUMBER as string);
  const answerUrl = baseUrl + routes.answerPath;
  const hangupUrl = baseUrl + routes.hangupPath;

  let previousApp: string | null = null;
  if (!args.call) {
    try {
      previousApp = await pointVobizNumber(answerUrl, hangupUrl);
    } catch (err) {
      fail("Could not configure the Vobiz number", err);
    }
  }

  const httpServer = http.createServer((req, res) => {
    const result = routeRequest(req.method, req.url, routes);
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    if (!isStreamRequest(request.url, routes)) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log("[vobiz] incoming audio stream connection");
      handleVobizCall(ws).catch((err) => {
        console.error(`Handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, "localhost", () => resolve());
  });

  console.log(`\nListening on ws://localhost:${PORT}/vobiz/<token>`);

  if (args.call) {
    let requestUuid: string;
    try {
      requestUuid = await placeOutboundCall(args.call, answerUrl, hangupUrl);
    } catch (err) {
      httpServer.close();
      fail("Could not place the call", err);
    }
    console.log(
      `Calling ${args.call} from ${VOBIZ_PHONE_NUMBER} (request=${requestUuid}). ` +
        `When they answer, they are bridged to ${FORWARD_TO_NUMBER}.`,
    );
  } else {
    console.log(
      `Vobiz number ${VOBIZ_PHONE_NUMBER} pointed at ${baseUrl}/answer/<token> ` +
        `(a fresh random token each run). Call it now.`,
    );
  }
  if (previousApp) {
    console.log(
      `(It was attached to Vobiz application ${previousApp}; ` +
        `re-attach it there when you are done.)`,
    );
  }
  console.log();
  return httpServer;
}

async function main(): Promise<void> {
  const httpServer = await startProxy(process.argv.slice(2));

  // Block forever until SIGINT.
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("\nShutting down.");
      resolve();
    });
  });

  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  process.exit(0);
}

// Only run main() when this file is executed directly (not when imported
// by tests).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
