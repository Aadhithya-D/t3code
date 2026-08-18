import { assert, describe, it } from "@effect/vitest";

import { isDesktopOAuthCallbackUrl, shouldCaptureDesktopOAuthUrl } from "./desktopInAppOAuth.ts";

describe("desktop in-app OAuth", () => {
  it("captures Clerk and Google hosts used by Connect sign-in", () => {
    assert.isTrue(shouldCaptureDesktopOAuthUrl("https://accounts.google.com/o/oauth2/v2/auth"));
    assert.isTrue(shouldCaptureDesktopOAuthUrl("https://clerk.t3.codes/v1/oauth/authorize"));
    assert.isTrue(shouldCaptureDesktopOAuthUrl("https://accounts.clerk.t3.codes/sign-in"));
    assert.isFalse(shouldCaptureDesktopOAuthUrl("https://github.com/pingdotgg/t3code"));
    assert.isFalse(shouldCaptureDesktopOAuthUrl("https://example.com"));
    assert.isFalse(shouldCaptureDesktopOAuthUrl("t3code://app/"));
  });

  it("recognizes the desktop Clerk callback URL", () => {
    assert.isTrue(isDesktopOAuthCallbackUrl("t3code://app/", "t3code", "app"));
    assert.isTrue(
      isDesktopOAuthCallbackUrl(
        "t3code://app/CLERK-ROUTER/VIRTUAL/sign-in?__clerk_status=complete",
        "t3code",
        "app",
      ),
    );
    assert.isFalse(isDesktopOAuthCallbackUrl("https://accounts.google.com", "t3code", "app"));
    assert.isFalse(isDesktopOAuthCallbackUrl("t3code-dev://app/", "t3code", "app"));
  });
});
