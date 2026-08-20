import { assert, describe, it } from "@effect/vitest";

import { resolveDesktopPasskeysEnabled } from "./desktopPasskeys.ts";

describe("desktop passkeys", () => {
  it("keeps native passkeys on for official builds", () => {
    assert.isTrue(resolveDesktopPasskeysEnabled(undefined));
    assert.isTrue(resolveDesktopPasskeysEnabled(true));
  });

  it("turns native passkeys off for unsigned personal builds", () => {
    assert.isFalse(resolveDesktopPasskeysEnabled(false));
  });
});
