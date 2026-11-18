# Speechmatics ↔ Vobiz Voice — Node.js / TypeScript Reference Integration

Bridges a Vobiz phone call to Speechmatics Realtime and prints
per-speaker transcripts to your local console.

> For the Python sibling, see [`../python/README.md`](../python/README.md).

This is a **reference implementation** for engineers and developers looking
to add Speechmatics transcription to a Vobiz-powered voice product using
the [`@speechmatics/real-time-client`](https://www.npmjs.com/package/@speechmatics/real-time-client)
JS SDK. Both sides of the call are transcribed via Speechmatics' multi-channel
diarization, so you get a clean `inbound` vs `outbound` split without any
client-side audio mixing.

See the [root README](../README.md#architecture) for the end-to-end
diagram of Caller ↔ Vobiz ↔ proxy ↔ Speechmatics.

## Prerequisites

- Node.js 20 or newer
- A [Speechmatics account](https://portal.speechmatics.com/) and API key
- A [Vobiz account](https://console.vobiz.ai/) with a voice-capable phone
  number, your Auth ID (`MA_...`) and Auth Token
- A **second** phone number to forward calls to
- An [ngrok](https://ngrok.com/) account and auth token (used to expose your
  local server to Vobiz), or an https tunnel you already run (`PUBLIC_URL`)

## Setup

```bash
# 1. Clone and enter the js/ folder
git clone <this-repo>
cd speechmatics-vobiz-integration/js

# 2. Install dependencies
npm install

# 3. Copy the env template at the repo root and fill in your keys.
#    (Both the Python and Node implementations read from ../.env.)
cp ../.env.example ../.env
$EDITOR ../.env
```

| Variable | What to put here |
|---|---|
| `SPEECHMATICS_API_KEY` | Your Speechmatics Realtime API key. |
| `NGROK_AUTHTOKEN` | Your ngrok auth token. Not needed when `PUBLIC_URL` is set. |
| `VOBIZ_AUTH_ID` | Your Vobiz Auth ID — it starts with `MA_`. |
| `VOBIZ_AUTH_TOKEN` | Your Vobiz Auth Token. |
| `VOBIZ_PHONE_NUMBER` | Your Vobiz number in E.164 form, e.g. `+918012345678`. |
| `FORWARD_TO_NUMBER` | The E.164 number the call bridges to — the second speaker. |
| `SPEECHMATICS_LANGUAGE` | Optional. Language code, e.g. `hi` for Hindi. Default `en`. |
| `SM_VOBIZ_PROXY_PORT` | Optional. Local server port. Default `5000`. |
| `PUBLIC_URL` | Optional. The `https://` URL of a tunnel you already run to that port (Cloudflare Tunnel, a reverse proxy, …). Replaces ngrok. Must be https: Vobiz fetches `/answer` over https and opens the audio stream over wss. |

## Run

### Inbound: someone calls your Vobiz number

```bash
npm start
```

On startup `proxy.ts` will:

1. Check your Speechmatics key, and stop before changing anything if it is
   rejected.
2. Open an ngrok tunnel (or use `PUBLIC_URL`).
3. Serve `/answer/<token>` on that tunnel, returning VobizXML: a
   `<Stream audioTrack="both">` to the proxy, a short `<Speak>` greeting,
   and a `<Dial>` to `FORWARD_TO_NUMBER`.
4. Create a Vobiz application named
   `speechmatics-transcription-<your number's digits>` (or update it on
   later runs) with that answer URL, and attach your Vobiz number to it.

Dial the Vobiz number from any phone; `FORWARD_TO_NUMBER` rings; answer
it, and the two-party conversation is transcribed live to the console.

### Outbound: Vobiz calls someone for you

```bash
npm start -- --call +918012345678
```

Once the server is listening, the proxy asks Vobiz to call that number from
`VOBIZ_PHONE_NUMBER`. When they answer, Vobiz fetches the same answer XML,
so the call is transcribed and bridged to `FORWARD_TO_NUMBER`. The answer
URL travels with the call request, so this mode **does not change your
number's inbound routing**.

### Notes

The answer, hangup and audio URLs carry a random token that changes on
every run, so only Vobiz, which is given them, can reach the proxy. The
stream WebSocket is unsigned, and Vobiz only signs HTTP callbacks when
callback credentials are configured, so the token is the access control.

The number stays attached to the `speechmatics-transcription-…` application
after Ctrl-C, and the next `npm start` points that application at the fresh
tunnel. If the number was attached to another application before, the proxy
prints its ID on startup so you can re-attach it in the Vobiz console.

## What you should see

```
[vobiz] incoming audio stream connection
[vobiz] call started - stream=c4dfd815-... call=5401fd2e-... tracks=["inbound","outbound"] format=audio/x-l16/16000
[outbound] This call is being transcribed.
[inbound ] Hello. Can you hear me?
[outbound] Yes, loud and clear.
[inbound ] Great.
[vobiz] call ended (stream=c4dfd815-...)
```

- **inbound** = the person who called the Vobiz number. With `--call`, it
  is the person being called.
- **outbound** = the person the call was forwarded to (`FORWARD_TO_NUMBER`),
  plus the greeting.
- **Transcripts from the two sides interleave** as they arrive, so a
  sentence can be split across lines. Closing punctuation may land on a later line.

## Key design choices

- **Multi-channel diarization**, not two separate sessions. One
  `MultiChannelRealtimeClient` handles both tracks over a single WebSocket
  and tags each transcript with its channel label.
- **`MultiChannelRealtimeClient`** is a thin subclass of the SDK's
  `RealtimeClient` that exposes `sendChannelAudio(channel, base64)` and
  `endChannel(...)` — the underlying `AddChannelAudio` / `EndOfChannel`
  wire messages are supported by the SDK types but not by a public method
  in the 8.5 line pinned here. The subclass is <10 lines.
- **Base64 pass-through, zero decoding.** Vobiz's `media.payload` is
  already base64; that's exactly the shape `AddChannelAudio.data` wants,
  so frames go straight through. Each payload is only checked to be valid
  base64, so a corrupt frame is dropped instead of sent.
- **16-bit linear PCM at 16 kHz, forwarded natively.** Speechmatics accepts
  L16 at 16 kHz as-is, so there is no transcoding stage.
- **The format follows `start.mediaFormat`.** Vobiz reports the format it
  sends when the stream opens, and the proxy tells Speechmatics exactly
  that. Changing the `<Stream contentType>` to 8 kHz L16 or μ-law needs no
  other change.
- **The end of the stream is the end of the call.** Vobiz closes the
  WebSocket when the call ends rather than sending a stop event.
- **No Vobiz SDK.** The four REST calls the proxy needs are made with
  Node's built-in `fetch`.

## Tests

See [`tests/README.md`](tests/README.md) for the Vitest suite that
covers the integration requirements.

## Troubleshooting

- **`Missing required env vars in .env: ...`** — copy `../.env.example`
  to `../.env` at the repo root and fill in the listed values.
- **`Could not authenticate with Speechmatics: ...`** — the proxy checks
  your key at startup and exits before it opens ngrok or changes your
  Vobiz number. Check `SPEECHMATICS_API_KEY`.
- **`PUBLIC_URL must start with https://`** — point `PUBLIC_URL` at the
  https address of your tunnel, or remove it to use ngrok.
- **`Vobiz number ... not found on this account`** — check that
  `VOBIZ_PHONE_NUMBER` is in E.164 form (leading `+`, country code, no
  spaces) and belongs to the account whose Auth ID and token you provided.
- **`Could not configure the Vobiz number: ... 401`** or
  **`Could not place the call: ... 401`** — check `VOBIZ_AUTH_ID` and
  `VOBIZ_AUTH_TOKEN`.
- **The caller hears the greeting, then the call ends** — the forward leg
  did not connect. Check `FORWARD_TO_NUMBER` is in E.164 form and that your
  account can call it; the call record in the Vobiz console shows the
  hangup cause.
- **No transcripts appear** — if you heard "This call is being
  transcribed", Vobiz reached `/answer`. Check the proxy printed
  `call started`; if it did, double-check `SPEECHMATICS_API_KEY`.
