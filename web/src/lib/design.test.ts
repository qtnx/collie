import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DISPLAY,
  DEFAULT_FONT,
  __resetDesign,
  designPrefs,
  parseDesignPrefs,
  setDesignDisplay,
  setDesignFont,
} from "@/lib/design";

// The store is a module singleton loaded once at import, so every case re-reads storage through
// `__resetDesign` rather than reaching for a fresh copy of the module.
beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  __resetDesign();
});

describe("parseDesignPrefs — the panel", () => {
  it("defaults to screen when the key is absent", () => {
    expect(parseDesignPrefs(JSON.stringify({ font: "aldrich" })).display).toBe(DEFAULT_DISPLAY);
  });

  it("keeps a stored mode", () => {
    expect(parseDesignPrefs(JSON.stringify({ display: "eink" })).display).toBe("eink");
  });

  // The whole reason the parse is total: a hand-edited blob, a value from a future build, and a
  // wrong type all have to resolve to the mode that changes nothing.
  it.each([
    ["an unknown mode", { display: "epaper" }],
    ["a number", { display: 3 }],
    ["a nested object", { display: { mode: "eink" } }],
    ["null", { display: null }],
  ])("falls back to screen for %s", (_label, doc) => {
    expect(parseDesignPrefs(JSON.stringify(doc)).display).toBe("screen");
  });

  it("reads face and panel out of the same blob", () => {
    const prefs = parseDesignPrefs(JSON.stringify({ font: "grotesk", display: "eink" }));
    expect(prefs).toEqual({ font: "grotesk", display: "eink" });
  });
});

describe("setDesignDisplay", () => {
  it("stamps the class, persists, and takes it off again", () => {
    setDesignDisplay("eink");
    expect([...document.documentElement.classList]).toContain("eink");
    expect(designPrefs().display).toBe("eink");
    expect(JSON.parse(localStorage.getItem("collie:design:v1") ?? "{}")).toMatchObject({
      display: "eink",
    });

    setDesignDisplay("screen");
    expect([...document.documentElement.classList]).not.toContain("eink");
    expect(designPrefs().display).toBe("screen");
  });

  it("ignores a mode outside the closed list", () => {
    setDesignDisplay("eink");
    setDesignDisplay("epaper");
    expect(designPrefs().display).toBe("eink");
    expect([...document.documentElement.classList]).toContain("eink");
  });

  // The two fields live in one key and one store, so each setter has to carry the other's value
  // through — a face change that quietly put an e-ink reader back on the backlit palette is the
  // exact bug the shared key invites.
  it("survives a change of face, and leaves the face alone in turn", () => {
    setDesignDisplay("eink");
    setDesignFont("grotesk");
    expect(designPrefs()).toEqual({ font: "grotesk", display: "eink" });
    expect([...document.documentElement.classList]).toEqual(
      expect.arrayContaining(["eink", "font-grotesk"]),
    );

    setDesignDisplay("screen");
    expect(designPrefs().font).toBe("grotesk");
  });

  it("re-applies the stored panel on a cold load", () => {
    localStorage.setItem(
      "collie:design:v1",
      JSON.stringify({ font: DEFAULT_FONT, display: "eink" }),
    );
    document.documentElement.className = "";
    __resetDesign();
    expect([...document.documentElement.classList]).toContain("eink");
  });
});
