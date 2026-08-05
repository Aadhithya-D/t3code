import { describe, expect, it } from "@effect/vitest";

import {
  detectMacCodeSignatureKind,
  resolveMacAppBundlePath,
  resolveMacUpdaterZipPath,
} from "./macAdhocInstall.ts";

describe("resolveMacAppBundlePath", () => {
  it("extracts the .app bundle from a macOS exec path", () => {
    expect(
      resolveMacAppBundlePath("/Applications/T3 Code Adi.app/Contents/MacOS/T3 Code Adi"),
    ).toBe("/Applications/T3 Code Adi.app");
  });

  it("returns null when the path is not inside an app bundle", () => {
    expect(resolveMacAppBundlePath("/usr/local/bin/t3")).toBeNull();
  });
});

describe("resolveMacUpdaterZipPath", () => {
  it("joins the updater cache dir under Library/Caches", () => {
    const zipPath = resolveMacUpdaterZipPath("t3code-updater");
    expect(zipPath.endsWith("/Library/Caches/t3code-updater/update.zip")).toBe(true);
  });
});

describe("detectMacCodeSignatureKind", () => {
  it("returns unknown for a missing path without throwing", () => {
    expect(detectMacCodeSignatureKind("/definitely/not/an/app.app")).toBe("unknown");
  });
});
