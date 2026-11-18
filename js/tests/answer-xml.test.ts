/**
 * Feature: Answer XML builder (buildAnswerXml)
 *
 * When a call comes in, Vobiz fetches our /answer endpoint and runs the
 * VobizXML we return. The response has to contain exactly the right
 * elements in the right order:
 *
 *   <Response>
 *     <Stream audioTrack="both" contentType="audio/x-l16;rate=16000">
 *       wss://.../vobiz/<token>
 *     </Stream>
 *     <Speak>...</Speak>
 *     <Dial callerId="<Vobiz number>" timeout="30">
 *       <Number>+E164</Number>
 *     </Dial>
 *   </Response>
 *
 * Malformed XML is not an HTTP error at Vobiz: it accepts the 200, then
 * drops the call. These tests pin the shape so refactors can't sneak a
 * regression in.
 */

import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";

import { buildAnswerXml, VOBIZ_CONTENT_TYPE } from "../proxy.js";

const STREAM_URL = "wss://tunnel.example.dev/vobiz/abc123";
// +44 7700 900xxx is Ofcom's reserved drama range - never a real subscriber.
const FORWARD_TO = "+447700900123";
const CALLER_ID = "+447700900456";

function parse(body: string) {
  // parseTagValue: false keeps the leading "+" on phone numbers - the
  // default would coerce "+447..." to a number and lose it.
  // preserveOrder keeps the element order, which Vobiz executes in.
  return new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
  }).parse(body);
}

function childOrder(body: string): string[] {
  const ordered = new XMLParser({ preserveOrder: true }).parse(body) as Record<string, unknown>[];
  const response = ordered.find((node) => "Response" in node) as { Response: Record<string, unknown>[] };
  return response.Response.map((node) => Object.keys(node).find((k) => k !== ":@") as string);
}

describe("buildAnswerXml", () => {
  it("wraps output in a <Response> root", () => {
    /**
     * Scenario: Document root element
     *   Given the answer XML for any inputs
     *    When it is parsed as XML
     *    Then a top-level "Response" node exists
     *
     * Purpose: Vobiz expects every VobizXML document to be wrapped in a
     * top-level <Response>. A naked <Stream> or <Dial> would be rejected.
     */
    const doc = parse(buildAnswerXml(STREAM_URL, FORWARD_TO, CALLER_ID));
    expect(doc.Response).toBeDefined();
  });

  it("forks both tracks to the proxy with a one-way <Stream>", () => {
    /**
     * Scenario: The <Stream> that forks the call audio
     *   Given the answer XML for a specific stream URL
     *    When the document is parsed
     *    Then <Response><Stream> exists
     *     And its text content is that stream URL verbatim
     *     And audioTrack is "both"
     *     And contentType is the L16/16 kHz format the proxy decodes
     *     And bidirectional and keepCallAlive are not set
     *
     * Purpose: the WebSocket URL is the element's text, not an attribute.
     * audioTrack="both" is what forks caller and callee into separate
     * tracks. A one-way stream does not block, which is what lets Vobiz go
     * on to <Dial>: bidirectional="true" cannot carry both tracks, and
     * keepCallAlive would hold the call on the stream.
     */
    const stream = parse(buildAnswerXml(STREAM_URL, FORWARD_TO, CALLER_ID)).Response.Stream;
    expect(stream["#text"].trim()).toBe(STREAM_URL);
    expect(stream["@_audioTrack"]).toBe("both");
    expect(stream["@_contentType"]).toBe(VOBIZ_CONTENT_TYPE);
    expect(stream["@_bidirectional"]).toBeUndefined();
    expect(stream["@_keepCallAlive"]).toBeUndefined();
  });

  it("bridges to the forwarding number from the Vobiz number via <Dial>", () => {
    /**
     * Scenario: The <Dial> that bridges to the second human
     *   Given the answer XML for a forwarding number and caller ID
     *    When the document is parsed
     *    Then <Dial><Number> holds the forwarding number verbatim
     *     And Dial's callerId is the Vobiz number
     *     And Dial sets an explicit 30 s ring timeout
     *
     * Purpose: without callerId, Vobiz presents the caller's number on the
     * second leg, which it cannot do, so the bridge fails and the call
     * falls through. The default ring timeout is 120 seconds.
     */
    const dial = parse(buildAnswerXml(STREAM_URL, FORWARD_TO, CALLER_ID)).Response.Dial;
    expect(String(dial.Number)).toBe(FORWARD_TO);
    expect(dial["@_callerId"]).toBe(CALLER_ID);
    expect(dial["@_timeout"]).toBe("30");
  });

  it("speaks a transcription notice between the Stream and the Dial", () => {
    /**
     * Scenario: The <Speak> greeting played before the bridge
     *   Given the answer XML for any inputs
     *    When the document is parsed
     *    Then the elements run Stream, Speak, Dial in that order
     *     And the greeting mentions "transcribed"
     *
     * Purpose: callers must be told the call is transcribed, and the
     * greeting lands on the transcript, which proves the stream started
     * first.
     */
    const body = buildAnswerXml(STREAM_URL, FORWARD_TO, CALLER_ID);
    expect(childOrder(body)).toEqual(["Stream", "Speak", "Dial"]);
    expect(String(parse(body).Response.Speak).toLowerCase()).toContain("transcribed");
  });

  it("XML-escapes values so a query string can't break the document", () => {
    /**
     * Scenario: A stream URL containing a query string
     *   Given a stream URL with two query parameters joined by "&"
     *    When the answer XML is built and parsed
     *    Then the raw document contains "&amp;", not a bare "&"
     *     And the URL round-trips unchanged
     *
     * Purpose: a bare "&" invalidates the document, and Vobiz then drops
     * the call with "Invalid Answer XML" in the CDR.
     */
    const url = "wss://tunnel.example.dev/vobiz/abc?a=1&b=2";
    const body = buildAnswerXml(url, FORWARD_TO, CALLER_ID);
    expect(body).toContain("a=1&amp;b=2");
    expect(parse(body).Response.Stream["#text"].trim()).toBe(url);
  });

  it("is byte-identical to the Python proxy's answer XML", () => {
    /**
     * Scenario: Parity with ../python/proxy.py _build_answer_xml
     *   Given the same stream URL, forwarding number and caller ID
     *    When the answer XML is built
     *    Then it equals the document the Python proxy serves
     *
     * Purpose: the two implementations are documented as behaving
     * identically; a Vobiz call must not depend on which one is running.
     */
    expect(buildAnswerXml(STREAM_URL, FORWARD_TO, CALLER_ID)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Stream audioTrack="both" contentType="audio/x-l16;rate=16000">' +
        "wss://tunnel.example.dev/vobiz/abc123</Stream>" +
        "<Speak>This call is being transcribed.</Speak>" +
        '<Dial callerId="+447700900456" timeout="30"><Number>+447700900123</Number></Dial>' +
        "</Response>",
    );
  });
});
