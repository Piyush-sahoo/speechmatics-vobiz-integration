# Speechmatics ↔ Vobiz Voice — Python Reference Integration

Bridges a Vobiz phone call to Speechmatics Realtime and prints
per-speaker transcripts to your local console.

> For the Node.js / TypeScript sibling, see [`../js/README.md`](../js/README.md).

This is a **reference implementation** for solutions engineers and developers
looking to add Speechmatics transcription to a Vobiz-powered voice product.
Both sides of the call are transcribed via Speechmatics' multi-channel
diarization, so you get a clean `inbound` vs `outbound` split without any
client-side audio mixing.

See the [root README](../README.md#architecture) for the end-to-end
diagram of Caller ↔ Vobiz ↔ proxy ↔ Speechmatics.

## Prerequisites

- Python 3.10 or newer
- A [Speechmatics account](https://portal.speechmatics.com/) and API key
- A [Vobiz account](https://console.vobiz.ai/) with a voice-capable phone
  number, your Auth ID (`MA_...`) and Auth Token
- An [ngrok](https://ngrok.com/) account and auth token (used to expose your
  local server to Vobiz), or your own HTTPS tunnel set as `PUBLIC_URL`

## Setup

```bash
# 1. Clone and enter the python/ folder
git clone <this-repo>
cd speechmatics-vobiz-integration/python

# 2. Create a virtualenv and install dependencies
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. Copy the env template at the repo root and fill in your keys.
#    (Both the Python and Node implementations read from ../.env.)
cp ../.env.example ../.env
$EDITOR ../.env
```

## Run

### Inbound: someone calls your Vobiz number

```bash
python proxy.py
```

On startup `proxy.py` will:

1. Check your Speechmatics key, and stop before changing anything if it is
   rejected.
2. Open an ngrok tunnel (or use `PUBLIC_URL`).
3. Serve an `/answer` endpoint on that tunnel that returns the required
   `<Stream audioTrack="both">` + short greeting + `<Dial>` to
   `FORWARD_TO_NUMBER`.
4. Create a Vobiz application named `speechmatics-transcription-<number>`
   (or update it on later runs) with that answer URL, and attach your Vobiz
   number to it.

Dial the Vobiz number from any phone; `FORWARD_TO_NUMBER` rings; answer
it, and the two-party conversation is transcribed live to the console.

The number stays attached to that application after Ctrl-C, and the next
run points the application at the fresh tunnel. If the number was attached
to another application before, the proxy prints its ID on startup so you
can re-attach it in the Vobiz console.

### Outbound: Vobiz calls someone

```bash
python proxy.py --call +918012345678
```

Vobiz calls that number from `VOBIZ_PHONE_NUMBER`. When they answer, they
hear the greeting and are bridged to `FORWARD_TO_NUMBER`, and both sides
are transcribed. Outbound mode does not change your number's routing.

The answer, hangup and audio paths carry a random token that changes on
every run, so they can't be guessed from the tunnel URL. The startup banner
shows them as `/answer/<token>`.

## What you should see

```
Listening on ws://localhost:5000/vobiz/<token>
Vobiz number +918012345678 pointed at https://xxxx.ngrok-free.app/answer/<token> (application speechmatics-transcription-918012345678). Call it now.

[vobiz] incoming audio stream connection
[vobiz] call started - stream=<stream id> call=<call id> tracks=['inbound', 'outbound'] format=audio/x-l16/16000
[outbound] This call is being transcribed.
[inbound ] Hello. Can you hear me?
[outbound] Yes, loud and clear.
[inbound ] Great.
[vobiz] call ended (stream=<stream id>)
```

- **inbound** = the person who called the Vobiz number (with `--call`, the
  person Vobiz called).
- **outbound** = the person the call was bridged to, plus the greeting.
- **Transcripts from the two sides interleave** as they arrive, so a
  sentence can be split across lines. Closing punctuation may land on a
  later line.

## Key design choices

- **Multi-channel diarization**, not two separate sessions. One
  Speechmatics `AsyncMultiChannelClient` handles both tracks in a single
  WebSocket connection and tags each transcript with its channel label.
- **16-bit PCM at 16 kHz forwarded natively**, no transcoding. Vobiz can
  stream L16 at 16 kHz and Speechmatics accepts it as-is. One less
  pipeline stage.
- **`chunk_size=640`** matches Vobiz's 20 ms frame at that format. The SDK
  reads round-robin from each source in chunks of this size, so anything
  larger just buffers audio and adds latency.
- **The format follows `start.mediaFormat`.** Vobiz reports the format it
  sends when the stream opens, and the proxy decodes with that. Changing
  the `<Stream contentType>` to 8 kHz L16 or μ-law needs no other change.
- **The end of the stream is the end of the call.** Vobiz closes the
  WebSocket when the call ends rather than sending a stop event.

## Tests

See [`tests/README.md`](tests/README.md) for the pytest suite that
covers the integration requirements.

## Troubleshooting

- **`Missing required env vars in .env: ...`** — copy `.env.example` to
  `.env` and fill in the listed values.
- **`Could not authenticate with Speechmatics: ...`** — the proxy checks
  your key at startup and exits before it opens a tunnel or changes your
  Vobiz number. Check `SPEECHMATICS_API_KEY`.
- **`Vobiz number ... not found on this account`** — check that
  `VOBIZ_PHONE_NUMBER` is in E.164 form and belongs to the account whose
  Auth ID and Auth Token you provided.
- **`Could not configure the Vobiz number: ... returned 401`** — check
  `VOBIZ_AUTH_ID` and `VOBIZ_AUTH_TOKEN`.
- **`PUBLIC_URL must start with https://`** — Vobiz fetches the answer
  URL over HTTPS and opens the audio stream over `wss://`.
- **The caller hears the greeting, then the call ends** — the forward leg
  did not connect. Check `FORWARD_TO_NUMBER` is in E.164 form and that
  your account can call it; the call record in the Vobiz console shows
  the hangup cause.
- **No transcripts appear** — if you heard the greeting, Vobiz reached
  `/answer`. Check the proxy printed `call started`; if it did, check
  `SPEECHMATICS_API_KEY`.
