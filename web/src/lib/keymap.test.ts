import { KEYMAP, LEADER, chordFor, resolveKey, type KeyEventLike, type KeyTarget } from "./keymap";

// What is pinned here is everything that would be silently WRONG in production rather than loudly
// broken: a bare letter firing while the operator types into a prompt, a two-key chord that eats the
// key after it, and the help sheet drifting from the table the resolver reads.

function press(key: string, over: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: "other",
    ...over,
  };
}

describe("the text boundary", () => {
  // The one rule that cannot be got wrong: while focus is in a field, a bare letter is that letter.
  it("refuses every bare binding in a text target", () => {
    for (const key of ["j", "k", "l", "h", "i", "/", "[", "]", "m", "?", "g"]) {
      expect(resolveKey(press(key, { target: "text" }), null)).toEqual({
        action: "none",
        pending: null,
      });
    }
  });

  it("still opens the palette from inside a field, on either Mod", () => {
    expect(resolveKey(press("k", { target: "text", metaKey: true }), null).action).toBe("palette");
    expect(resolveKey(press("p", { target: "text", ctrlKey: true }), null).action).toBe("palette");
  });

  it("maps Escape in a field to blur, and out of one to back", () => {
    expect(resolveKey(press("Escape", { target: "text" }), null).action).toBe("blur");
    expect(resolveKey(press("Escape"), null).action).toBe("back");
  });
});

describe("the palette", () => {
  it("answers to Mod+K and Mod+P, upper or lower case", () => {
    for (const key of ["k", "K", "p", "P"]) {
      expect(resolveKey(press(key, { metaKey: true }), null).action).toBe("palette");
      expect(resolveKey(press(key, { ctrlKey: true }), null).action).toBe("palette");
    }
  });

  // A bare `k` is "move up". Requiring the modifier in BOTH directions is what keeps the two apart.
  it("does not fire unmodified, and `k` alone is not the palette", () => {
    expect(resolveKey(press("k"), null).action).toBe("up");
  });
});

describe("the g prefix", () => {
  it("arms on g and resolves the chord on the next key", () => {
    const armed = resolveKey(press(LEADER), null);
    expect(armed).toEqual({ action: "none", pending: "g" });
    expect(resolveKey(press("h"), armed.pending).action).toBe("home");
    expect(resolveKey(press("s"), armed.pending).action).toBe("settings");
  });

  // The prefix must not swallow the key after it: `g` then `j` is still a move, not a dead press.
  it("falls through to the plain binding when the chord is unknown", () => {
    expect(resolveKey(press("j"), LEADER)).toEqual({ action: "down", pending: null });
  });

  it("does not arm from inside a field, or with Mod held", () => {
    expect(resolveKey(press(LEADER, { target: "text" }), null).pending).toBeNull();
    expect(resolveKey(press(LEADER, { metaKey: true }), null).pending).toBeNull();
  });

  // Bare `h` is "back"; the chord wins only while the prefix is pending.
  it("leaves bare h as back once the prefix has been consumed", () => {
    expect(resolveKey(press("h"), null).action).toBe("back");
  });
});

describe("the plain bindings", () => {
  it("maps each key to its action outside a field", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["?", "help"],
      ["j", "down"],
      ["k", "up"],
      ["l", "open"],
      ["Enter", "open"],
      ["/", "search"],
      ["i", "compose"],
      ["[", "prevPane"],
      ["]", "nextPane"],
      ["m", "mute"],
    ];
    for (const [key, action] of cases) {
      expect(resolveKey(press(key), null).action).toBe(action);
    }
  });

  it("ignores an unbound key and a Mod-held bare binding", () => {
    expect(resolveKey(press("z"), null).action).toBe("none");
    expect(resolveKey(press("j", { metaKey: true }), null).action).toBe("none");
  });

  // Alt is how several layouts type accented characters, so a press carrying it is the operator
  // writing rather than navigating.
  it("ignores anything with Alt held", () => {
    expect(resolveKey(press("j", { altKey: true }), null).action).toBe("none");
    expect(resolveKey(press("k", { altKey: true, metaKey: true }), null).action).toBe("none");
  });

  it("clears a pending prefix on a press it cannot use", () => {
    expect(resolveKey(press("z"), LEADER).pending).toBeNull();
  });
});

describe("the table", () => {
  // The help sheet renders KEYMAP directly, so every row must be reachable through the resolver —
  // a row nothing can trigger would document a shortcut that does not exist.
  it("resolves every row through the key it declares", () => {
    for (const binding of KEYMAP) {
      const key = binding.keys[0] ?? "";
      const target: KeyTarget = binding.text === "only" ? "text" : "other";
      const pending = binding.prefix ?? null;
      const resolved = resolveKey(press(key, { target, metaKey: binding.mod ?? false }), pending);
      expect(resolved.action).toBe(binding.action);
    }
  });

  it("gives every row a printable chord and a label key", () => {
    for (const binding of KEYMAP) {
      expect(chordFor(binding).length).toBeGreaterThan(0);
      expect(binding.labelKey.startsWith("nav.help.action.")).toBe(true);
    }
    expect(chordFor({ action: "help", keys: ["?"], labelKey: "nav.help.action.help" })).toBe("?");
  });
});
