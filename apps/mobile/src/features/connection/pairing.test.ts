import { describe, expect, it } from "vite-plus/test";

import { setCurrentLanguage } from "../../i18n/runtime";

setCurrentLanguage("en");

import {
  buildPairingUrl,
  extractPairingUrlFromQrPayload,
  PairingQrPayloadEmptyError,
  parsePairingUrl,
} from "./pairing";

describe("buildPairingUrl", () => {
  it("粘贴新链接后使用其中的配对码，不沿用旧表单值", () => {
    const link = "http://192.168.1.100:3773/pair#token=New%2BToken";
    expect(buildPairingUrl(link, "expired-code")).toBe(
      "http://192.168.1.100:3773/#token=New%2BToken",
    );
    expect(parsePairingUrl(link)).toEqual({
      host: "http://192.168.1.100:3773",
      code: "New+Token",
    });
  });
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("trims raw pairing urls from qr payloads", () => {
    expect(
      extractPairingUrlFromQrPayload("  https://remote.example.com/pair#token=pairing-token  "),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it.each([
    "codework://",
    "codework-dev://",
    "codework-preview://",
    "t3code://",
    "t3code-dev://",
    "t3code-preview://",
  ])("unwraps %s mobile deep links that carry an encoded pairing url", (scheme) => {
    expect(
      extractPairingUrlFromQrPayload(
        `${scheme}pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token`,
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("rejects empty qr payloads", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(PairingQrPayloadEmptyError);
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(
      "Scanned QR code did not contain a pairing URL.",
    );
  });
});

describe("parsePairingUrl", () => {
  it("扫码和粘贴都兼容旧版开发客户端链接", () => {
    const link =
      "t3code-dev://connections/new?pairingUrl=" +
      encodeURIComponent("http://192.168.1.100:3773/pair#token=pairing-token");
    expect(parsePairingUrl(link)).toEqual({
      host: "http://192.168.1.100:3773",
      code: "pairing-token",
    });
  });

  it("保留 IPv6 地址和配对码大小写", () => {
    const link = buildPairingUrl("[fd00::1234]:3773", "AbC-123");
    expect(parsePairingUrl(link)).toEqual({
      host: "http://[fd00::1234]:3773",
      code: "AbC-123",
    });
  });
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
