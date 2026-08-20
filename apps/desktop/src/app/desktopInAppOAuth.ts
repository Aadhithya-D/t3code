import * as Electron from "electron";

const OAUTH_HOSTS = [
  "accounts.google.com",
  "clerk.t3.codes",
  "accounts.clerk.t3.codes",
  "clerk.accounts.dev",
  "appleid.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
] as const;

export function shouldCaptureDesktopOAuthUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    return OAUTH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

export function isDesktopOAuthCallbackUrl(rawUrl: string, scheme: string, host: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${scheme}:` && url.hostname === host;
  } catch {
    return false;
  }
}

function emitDesktopOAuthCallback(callbackUrl: string): void {
  const event = {
    preventDefault: () => undefined,
  };
  Electron.app.emit("open-url", event, callbackUrl);
}

function openDesktopOAuthWindow(input: {
  readonly startUrl: string;
  readonly scheme: string;
  readonly host: string;
}): void {
  const window = new Electron.BrowserWindow({
    width: 480,
    height: 740,
    title: "Sign in to T3 Connect",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const maybeHandleCallback = (rawUrl: string): boolean => {
    if (!isDesktopOAuthCallbackUrl(rawUrl, input.scheme, input.host)) {
      return false;
    }
    emitDesktopOAuthCallback(rawUrl);
    if (!window.isDestroyed()) {
      window.close();
    }
    return true;
  };

  window.webContents.on("will-navigate", (event, url) => {
    if (maybeHandleCallback(url)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (maybeHandleCallback(url)) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (maybeHandleCallback(url)) {
      return { action: "deny" };
    }
    if (shouldCaptureDesktopOAuthUrl(url) && !window.isDestroyed()) {
      void window.loadURL(url);
    }
    return { action: "deny" };
  });

  void window.loadURL(input.startUrl);
}

/**
 * Clerk's Electron OAuth transport opens Google in the system browser and waits
 * for a t3code:// callback. Official T3 Code usually owns that scheme, so the
 * personal unsigned app never sees the return. Keep the flow in-process.
 */
export function installDesktopInAppOAuth(input: {
  readonly scheme: string;
  readonly host: string;
}): void {
  const originalOpenExternal = Electron.shell.openExternal.bind(Electron.shell);
  const openExternal: typeof Electron.shell.openExternal = async (url, options) => {
    if (!shouldCaptureDesktopOAuthUrl(url)) {
      return originalOpenExternal(url, options);
    }
    openDesktopOAuthWindow({
      startUrl: url,
      scheme: input.scheme,
      host: input.host,
    });
  };
  Electron.shell.openExternal = openExternal;
}
