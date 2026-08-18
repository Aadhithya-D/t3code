import { describe, expect, it } from "vite-plus/test";

import {
  cliPackageNodeModulesSegments,
  DEFAULT_CLI_PACKAGE_NAME,
  formatCliPackageSpec,
  normalizeCliPackageName,
} from "./cliPackage.ts";

describe("cliPackage", () => {
  it("defaults empty names to the upstream t3 package", () => {
    expect(normalizeCliPackageName(undefined)).toBe(DEFAULT_CLI_PACKAGE_NAME);
    expect(normalizeCliPackageName("")).toBe(DEFAULT_CLI_PACKAGE_NAME);
    expect(normalizeCliPackageName("   ")).toBe(DEFAULT_CLI_PACKAGE_NAME);
    expect(normalizeCliPackageName("@adithyasak/t3")).toBe("@adithyasak/t3");
  });

  it("formats pinned and channel package specs", () => {
    expect(formatCliPackageSpec("t3", "0.0.34")).toBe("t3@0.0.34");
    expect(formatCliPackageSpec("@adithyasak/t3", "0.0.34-adi.1")).toBe(
      "@adithyasak/t3@0.0.34-adi.1",
    );
    expect(formatCliPackageSpec("  ", "nightly")).toBe("t3@nightly");
  });

  it("splits scoped package names into node_modules path segments", () => {
    expect(cliPackageNodeModulesSegments("t3")).toEqual(["t3"]);
    expect(cliPackageNodeModulesSegments("@adithyasak/t3")).toEqual(["@adithyasak", "t3"]);
  });
});
