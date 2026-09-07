import { expect, test } from "bun:test";

import { renderLiveInstructions } from "./instructions.ts";

test("renders Collie identity, terminal agent, and display language", () => {
  const instructions = renderLiveInstructions({
    firstName: "Ada",
    username: "ada.lovelace",
    agent: "codex",
    cwd: "/work/collie",
    language: "de",
  });

  expect(instructions.startsWith("You: Collie Live, realtime voice surface of one unified coding assistant for Ada (OS account: ada.lovelace).")).toBe(true);
  expect(instructions).toContain("the codex agent running in the operator's terminal in /work/collie");
  expect(instructions).toContain("Your default spoken language is German.");
  expect(instructions).not.toContain("{{agent}}");
});
