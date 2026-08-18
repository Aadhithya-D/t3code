declare const __T3CODE_DESKTOP_PASSKEYS__: boolean | undefined;

export function resolveDesktopPasskeysEnabled(flag: boolean | undefined): boolean {
  return flag === undefined || flag !== false;
}

/**
 * Official signed macOS builds keep native Clerk passkeys on. Unsigned personal
 * builds set T3CODE_DESKTOP_PASSKEYS=0 so Connect sign-in does not call
 * Authentication Services without an application-identifier entitlement.
 */
export const desktopPasskeysEnabled = resolveDesktopPasskeysEnabled(
  typeof __T3CODE_DESKTOP_PASSKEYS__ === "undefined" ? undefined : __T3CODE_DESKTOP_PASSKEYS__,
);
