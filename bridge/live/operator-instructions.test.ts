import { describe, expect, test } from "bun:test";

import { renderOperatorInstructions } from "./operator-instructions.ts";

describe("renderOperatorInstructions", () => {
  test("describes constrained pane operation and spoken output", () => {
    const text = renderOperatorInstructions({ agent: "claude", cwd: "/repo", paneId: "p1", language: "English" });
    expect(text).toContain("ONE terminal pane running claude in /repo");
    expect(text).toContain("ALWAYS call read_screen first");
    expect(text).toContain("type_text sends a complete message");
    expect(text).toContain("2–5 spoken sentences in English");
    expect(text.split("\n").length).toBeLessThanOrEqual(40);
  });
});
