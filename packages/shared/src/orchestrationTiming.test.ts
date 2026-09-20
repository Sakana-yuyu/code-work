import { describe, expect, it } from "vite-plus/test";

import { formatDuration } from "./orchestrationTiming.ts";

describe("formatDuration", () => {
  it("keeps the sub-minute ladder unchanged", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(9_400)).toBe("9.4s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(61_000)).toBe("1m 1s");
  });

  it("renders hours with a rounded minute remainder", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(25_809_000)).toBe("7h 10m");
    expect(formatDuration(3_600_000 * 2 + 59 * 60_000)).toBe("2h 59m");
    expect(formatDuration(3_600_000 * 3 + 59.6 * 60_000)).toBe("4h");
  });

  it("renders days with a rounded hour remainder", () => {
    expect(formatDuration(86_400_000)).toBe("1d");
    expect(formatDuration(86_400_000 + 3_600_000 * 5)).toBe("1d 5h");
    expect(formatDuration(86_400_000 * 2 + 3_600_000 * 23.6)).toBe("3d");
  });
});
