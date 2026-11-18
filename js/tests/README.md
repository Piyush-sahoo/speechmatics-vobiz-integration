# Node.js tests

Vitest suite covering the pieces of `../proxy.ts` that map to the
integration requirements — session routing, answer XML generation, Vobiz
number setup and outbound calls, request routing, startup order, and Vobiz
audio stream event handling. It uses a fake WebSocket, spies on
`CallSession`, and mocks Speechmatics auth, the Speechmatics RT client,
ngrok and `fetch`, so no live services (Vobiz, Speechmatics, ngrok) are
contacted while the tests run. The only socket opened is the proxy's own
server on a random loopback port.

## Run

From the `js/` folder:

```bash
npm install
npm test           # single run
npm run test:watch # re-run on file changes
npm run typecheck  # tsc --noEmit
```

## Layout

```
tests/
├── answer-xml.test.ts       # <Response> / <Stream> / <Speak> / <Dial> shape
├── auth-failure.test.ts     # bad Speechmatics key: startup check + per-call failure
├── call-session.test.ts     # frame routing, wire-format constants, close cascade
├── handler.test.ts          # handleVobizCall end-to-end (mocked)
├── session-config.test.ts   # StartRecognition: channels, language, audio_format
├── startup.test.ts          # startProxy order, --call, PUBLIC_URL, routeRequest
└── vobiz-number.test.ts     # application create/update/paging, number attach, API errors
```

Each test file starts with a `Feature:` block describing the area it
covers; each test carries a Gherkin-style `Scenario:` docstring plus a
`Purpose:` line explaining why it exists and what it protects against.

## Adapting for your own integration

Use this suite as scaffolding — swap in your own handler code inside
`proxy.ts`, then re-run `npm test` to confirm you haven't broken the
contract with Vobiz or Speechmatics.
