import { foldTranscriptRows, phoneLivePhase } from "./live";
import type { LiveTranscriptRow } from "@/lib/types";

// The two rules the call's display rests on, and both are easy to get subtly wrong in a way nothing
// else would catch: the phase word (a merge of the bridge's answer and facts only this browser has)
// and the transcript fold (rows REPLACE by (role, turn) rather than accumulating).

function row(over: Partial<LiveTranscriptRow> = {}): LiveTranscriptRow {
  return { seq: 1, role: "user", turn: 1, text: "hello", final: false, ...over };
}

describe("phoneLivePhase", () => {
  it("lets the bridge's ending win over everything the browser knows", () => {
    // Muted and speaking are true facts here, and neither may hide that the call is over.
    expect(phoneLivePhase("ended", true, 0.9)).toBe("ended");
    expect(phoneLivePhase("error", true, 0.9)).toBe("error");
  });

  it("shows muted above every phase the call is still running in", () => {
    expect(phoneLivePhase("listening", true, 0)).toBe("muted");
    expect(phoneLivePhase("working", true, 0)).toBe("muted");
    // Even while the assistant is audibly speaking: the operator's own mute is the thing they need
    // confirmed, and the voice coming through is not evidence against it.
    expect(phoneLivePhase("listening", true, 0.9)).toBe("muted");
  });

  it("shows the delegation above the audio, because the agent is the slow part", () => {
    expect(phoneLivePhase("working", false, 0)).toBe("working");
    expect(phoneLivePhase("working", false, 0.9)).toBe("working");
  });

  it("says connecting until the bridge says the call is up", () => {
    expect(phoneLivePhase("connecting", false, 0)).toBe("connecting");
  });

  it("reads speaking off the output level, and listening off its absence", () => {
    expect(phoneLivePhase("listening", false, 0.2)).toBe("speaking");
    expect(phoneLivePhase("listening", false, 0)).toBe("listening");
    // The threshold is what stops room noise on the far side reading as speech; a level AT it is
    // still silence, which is the boundary a `>` gets right and a `>=` does not.
    expect(phoneLivePhase("listening", false, 0.015)).toBe("listening");
    expect(phoneLivePhase("listening", false, 0.016)).toBe("speaking");
  });
});

describe("foldTranscriptRows", () => {
  it("keeps the latest row per side", () => {
    const folded = foldTranscriptRows(
      {},
      [row({ seq: 1, text: "hi" }), row({ seq: 2, role: "assistant", text: "hello there" })],
    );
    expect(folded.user?.text).toBe("hi");
    expect(folded.assistant?.text).toBe("hello there");
  });

  it("REPLACES a row of the same (role, turn) rather than appending to it", () => {
    // The partial-to-final growth of one sentence. Appending would render "what" + "what is" +
    // "what is failing" stacked; this is why the fold exists at all.
    const folded = foldTranscriptRows({}, [
      row({ seq: 1, turn: 3, text: "what" }),
      row({ seq: 2, turn: 3, text: "what is" }),
      row({ seq: 3, turn: 3, text: "what is failing", final: true }),
    ]);
    expect(folded.user).toEqual(row({ seq: 3, turn: 3, text: "what is failing", final: true }));
  });

  it("replaces across polls, not just within one batch", () => {
    const first = foldTranscriptRows({}, [row({ seq: 1, turn: 2, text: "check" })]);
    const second = foldTranscriptRows(first, [
      row({ seq: 2, turn: 2, text: "check the logs", final: true }),
    ]);
    expect(second.user?.text).toBe("check the logs");
  });

  it("advances to a new turn and drops the previous one", () => {
    const first = foldTranscriptRows({}, [row({ seq: 1, turn: 1, text: "first question" })]);
    const second = foldTranscriptRows(first, [row({ seq: 2, turn: 2, text: "second question" })]);
    expect(second.user?.turn).toBe(2);
    expect(second.user?.text).toBe("second question");
  });

  it("ignores a row from an older turn arriving late", () => {
    // A poll can straddle a turn boundary, and rows are ordered by seq — not by turn — so a late row
    // from the turn before must not overwrite the one now on screen.
    const current = foldTranscriptRows({}, [row({ seq: 5, turn: 4, text: "current" })]);
    const folded = foldTranscriptRows(current, [row({ seq: 6, turn: 3, text: "stale" })]);
    expect(folded.user?.text).toBe("current");
  });

  it("keeps the other side untouched when only one speaks", () => {
    const started = foldTranscriptRows({}, [
      row({ seq: 1, role: "assistant", turn: 1, text: "how can I help?" }),
    ]);
    const folded = foldTranscriptRows(started, [row({ seq: 2, role: "user", text: "one moment" })]);
    expect(folded.assistant?.text).toBe("how can I help?");
    expect(folded.user?.text).toBe("one moment");
  });

  it("returns the previous lines unchanged when a poll brings no rows", () => {
    const previous = foldTranscriptRows({}, [row({ seq: 1, text: "still here" })]);
    expect(foldTranscriptRows(previous, [])).toEqual(previous);
  });
});
