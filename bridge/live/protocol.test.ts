import { describe, expect, test } from "bun:test";

import {
  CONTEXT_CHUNK_BYTES,
  buildDelegationContextAppend,
  buildLiveSessionPayload,
  buildSessionClose,
  chunkLiveContext,
  parseLiveServerEvent,
} from "./protocol.ts";

describe("parseLiveServerEvent", () => {
  test("parses every supported wire shape", () => {
    expect(parseLiveServerEvent('{"type":"session.started","session":{"id":"s","instructions":"i"}}')).toEqual({
      type: "session.started",
      session: { id: "s", instructions: "i" },
    });
    expect(parseLiveServerEvent({ type: "session.updated", session: { id: "s" } })).toEqual({
      type: "session.updated",
      session: { id: "s" },
    });
    expect(parseLiveServerEvent({ type: "output_audio.delta", audio: "pcm" })).toEqual({
      type: "output_audio.delta",
      audio: "pcm",
    });
    expect(parseLiveServerEvent({ type: "input_transcript.added", item: { text: "hello" } })).toEqual({
      type: "input_transcript.added",
      item: { text: "hello" },
    });
    expect(parseLiveServerEvent({ type: "output_transcript.added", item: { text: "answer" } })).toEqual({
      type: "output_transcript.added",
      item: { text: "answer" },
    });
    expect(parseLiveServerEvent({ type: "turn.done", turn: { role: "assistant", transcript: "done" } })).toEqual({
      type: "turn.done",
      turn: { role: "assistant", transcript: "done" },
    });
    expect(
      parseLiveServerEvent({
        type: "delegation.created",
        item: { type: "delegation", target: "client", id: "d", content: [{ type: "input_text", text: "work" }] },
      }),
    ).toEqual({
      type: "delegation.created",
      item: { type: "delegation", target: "client", id: "d", content: [{ type: "input_text", text: "work" }] },
    });
    expect(parseLiveServerEvent({ type: "error", error: { message: "bad" } })).toEqual({ type: "error", message: "bad" });
    expect(parseLiveServerEvent({ type: "new.event" })).toEqual({ type: "unknown", wireType: "new.event" });
  });

  test("rejects malformed payloads", () => {
    expect(parseLiveServerEvent("not json")).toBeNull();
    expect(parseLiveServerEvent({ type: "turn.done", turn: { role: "system", transcript: "no" } })).toBeNull();
  });
});

test("builds live messages", () => {
  expect(buildLiveSessionPayload("instructions", "sol")).toEqual({
    model: "gpt-live-1-codex",
    instructions: "instructions",
    audio: { output: { voice: "sol" } },
    delegation: { type: "client" },
  });
  expect(buildDelegationContextAppend("d", "text", "commentary")).toEqual({
    type: "delegation.context.append",
    delegation_item_id: "d",
    channel: "commentary",
    content: [{ type: "input_text", text: "text" }],
  });
  expect(buildSessionClose()).toEqual({ type: "session.close" });
});

test("chunks UTF-8 without splitting four-byte characters", () => {
  const chunks = chunkLiveContext("a".repeat(CONTEXT_CHUNK_BYTES - 2) + "😀x");
  expect(chunks).toEqual(["a".repeat(CONTEXT_CHUNK_BYTES - 2), "😀x"]);
  expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= CONTEXT_CHUNK_BYTES)).toBe(true);
});
