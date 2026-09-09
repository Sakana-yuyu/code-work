import { describe, expect, it, vi } from "vite-plus/test";
import { revealTerminalPanel } from "./panelVisibility";

describe("IDE terminal panel visibility", () => {
  it("reveals a hidden panel", async () => {
    const show = vi.fn(async () => {});

    expect(await revealTerminalPanel(false, show)).toBe(true);
    expect(show).toHaveBeenCalledOnce();
  });

  it("does not toggle an already visible panel", async () => {
    const show = vi.fn(async () => {});

    expect(await revealTerminalPanel(true, show)).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });
});
