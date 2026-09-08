import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DisplayControl } from "@/components/display-control";
import { __resetDesign, designPrefs } from "@/lib/design";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  __resetDesign();
});

describe("DisplayControl", () => {
  it("renders both panels with Screen selected by default", () => {
    render(<DisplayControl />);

    const group = screen.getByRole("radiogroup", { name: "Display" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual(["Screen", "E-ink"]);
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("switches the pref on selection, stamping the class and persisting it", async () => {
    render(<DisplayControl />);

    await userEvent.click(screen.getByRole("radio", { name: "E-ink" }));

    expect(screen.getByRole("radio", { name: "E-ink" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Screen" })).toHaveAttribute("aria-checked", "false");
    expect([...document.documentElement.classList]).toContain("eink");
    expect(designPrefs().display).toBe("eink");
  });

  it("switches back, taking the class off again", async () => {
    render(<DisplayControl />);

    await userEvent.click(screen.getByRole("radio", { name: "E-ink" }));
    await userEvent.click(screen.getByRole("radio", { name: "Screen" }));

    expect(screen.getByRole("radio", { name: "Screen" })).toHaveAttribute("aria-checked", "true");
    expect([...document.documentElement.classList]).not.toContain("eink");
    expect(designPrefs().display).toBe("screen");
  });

  it("opens on the stored panel rather than being told after mount", () => {
    localStorage.setItem("collie:design:v1", JSON.stringify({ font: "aldrich", display: "eink" }));
    __resetDesign();

    render(<DisplayControl />);

    expect(screen.getByRole("radio", { name: "E-ink" })).toHaveAttribute("aria-checked", "true");
  });
});
