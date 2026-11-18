/**
 * Feature: the StartRecognition message a call sends to Speechmatics
 *
 *   One multi-channel session per call, labelled with Vobiz's track names,
 *   and an audio_format that is exactly what Vobiz said it is sending in
 *   start.mediaFormat. If the format is wrong Speechmatics decodes noise
 *   and returns nothing, with no error.
 *
 * @speechmatics/auth and @speechmatics/real-time-client are mocked, so no
 * network is involved. This lives in its own file because vi.mock applies
 * to the whole module graph of a test file.
 */

import { describe, expect, it, vi } from "vitest";

const started = vi.hoisted(() => {
  process.env.SPEECHMATICS_API_KEY = "test-key-not-real";
  process.env.SPEECHMATICS_LANGUAGE = "hi";
  return [] as { jwt: string; config: Record<string, unknown> }[];
});

vi.mock("@speechmatics/auth", () => ({
  createSpeechmaticsJWT: vi.fn().mockResolvedValue("jwt-for-test"),
}));

vi.mock("@speechmatics/real-time-client", () => ({
  RealtimeClient: class extends EventTarget {
    async start(jwt: string, config: Record<string, unknown>) {
      started.push({ jwt, config });
    }
    async stopRecognition() {}
    sendMessage() {}
  },
}));

import { audioFormatFor, CallSession } from "../proxy.js";

async function startWith(encoding: string, sampleRate: number) {
  started.length = 0;
  const session = new CallSession(audioFormatFor({ encoding, sampleRate }) ?? undefined);
  session.start();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (session as any).startPromise;
  return started[0];
}

describe("StartRecognition", () => {
  it("asks for one channel-diarized session labelled inbound/outbound", async () => {
    /**
     * Scenario: A call with the default L16/16 kHz stream starts
     *   Given a minted JWT
     *    When the session starts
     *    Then the client is started with that JWT
     *     And diarization is "channel" with labels ["inbound", "outbound"]
     *     And the language comes from SPEECHMATICS_LANGUAGE
     *
     * Purpose: both speakers in one session, each transcript tagged with
     * the Vobiz track it came from.
     */
    const { jwt, config } = await startWith("audio/x-l16", 16000);
    expect(jwt).toBe("jwt-for-test");
    expect(config.transcription_config).toMatchObject({
      language: "hi",
      diarization: "channel",
      channel_diarization_labels: ["inbound", "outbound"],
      enable_partials: true,
      max_delay: 0.7,
    });
  });

  it.each([
    ["audio/x-l16", 16000, "pcm_s16le"],
    ["audio/x-l16", 8000, "pcm_s16le"],
    ["audio/x-mulaw", 8000, "mulaw"],
  ])("sends audio_format matching %s at %i Hz", async (encoding, sampleRate, expected) => {
    /**
     * Scenario Outline: The audio format follows start.mediaFormat
     *   Given Vobiz reported <encoding>/<sampleRate>
     *    When the session starts
     *    Then audio_format is raw <expected> at <sampleRate>
     *     And it carries no fields Speechmatics does not define
     */
    const { config } = await startWith(encoding, sampleRate);
    expect(config.audio_format).toEqual({ type: "raw", encoding: expected, sample_rate: sampleRate });
  });
});
