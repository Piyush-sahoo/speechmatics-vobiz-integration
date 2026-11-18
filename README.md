# Speechmatics ↔ Vobiz Voice — Reference Integration

A local proxy that bridges a Vobiz phone call to Speechmatics Realtime
and prints per-speaker transcripts to your console. Both sides of a bridged
two-party call are transcribed via Speechmatics' multi-channel diarization —
you get a clean `inbound` vs `outbound` split with no client-side audio mixing.

This repo ships two identical-behaviour implementations. Pick the one that
matches your stack and follow the README in that folder:

| Language | Folder | Start here |
|---|---|---|
| Python | [`python/`](python/) | [`python/README.md`](python/README.md) |
| Node.js / TypeScript | [`js/`](js/) | [`js/README.md`](js/README.md) |

## Architecture

```
  ┌──────────┐      ┌────────┐      ┌──────────┐
  │ Caller A │◀──══▶│ Vobiz  │◀──══▶│ Caller B │      ═══  bridged voice
  └──────────┘      └────┬───┘      └──────────┘           (PSTN)
                         │
                         │  audio fork  (both tracks, 16-bit PCM 16 kHz)
                         ▼
                 ┌───────────────┐
                 │ proxy.py /    │
                 │ proxy.ts      │
                 └───────┬───────┘
                         │
                         │  Realtime WebSocket
                         ▼
             ┌───────────────────────┐
             │ Speechmatics Realtime │
             │ (multi-channel)       │
             └───────────┬───────────┘
                         │
                         │  per-channel transcripts
                         ▼
                    ┌─────────┐
                    │ console │
                    └─────────┘
```

- **Caller A** dials the Vobiz number; Vobiz bridges the call to
  **Caller B** via VobizXML `<Dial>` — two people talk normally.
- Vobiz simultaneously **forks** the live call audio (both tracks) to
  the proxy over WebSocket with `<Stream audioTrack="both">`, as 16-bit
  linear PCM at 16 kHz.
- The proxy relays those frames to Speechmatics Realtime — **no
  transcoding**, no re-encoding.
- Speechmatics returns per-channel transcripts tagged with the track
  they came from; the proxy prints the finals to the console. Consecutive
  finals on one channel continue on the same line, and a change of channel
  starts a new line. Partial transcripts are requested but not printed -
  the handlers are stubs for you to wire in.

The language-specific READMEs cover prerequisites, setup, `.env` variables, what to
expect at runtime, tests, and troubleshooting.
