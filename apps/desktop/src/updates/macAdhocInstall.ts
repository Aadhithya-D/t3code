// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

/**
 * Personal / unsigned macOS builds are ad-hoc signed. Electron's Squirrel.Mac
 * updater (used by electron-updater) requires a real code signature to swap
 * the app bundle and relaunch. Without that, `quitAndInstall` often quits and
 * never comes back.
 *
 * For ad-hoc apps we install by extracting the already-downloaded update.zip
 * after this process exits, then reopening the .app bundle ourselves.
 */

export type MacCodeSignatureKind = "adhoc" | "signed" | "unknown";

export function resolveMacAppBundlePath(execPath: string): string | null {
  const marker = ".app";
  const index = execPath.indexOf(marker);
  if (index === -1) {
    return null;
  }
  const end = index + marker.length;
  // Require the marker to end the path segment (…/App.app or …/App.app/…)
  const next = execPath[end];
  if (next !== undefined && next !== "/" && next !== "\\") {
    return null;
  }
  return execPath.slice(0, end);
}

export function detectMacCodeSignatureKind(appBundlePath: string): MacCodeSignatureKind {
  try {
    const result = NodeChildProcess.spawnSync("codesign", ["-dv", "--verbose=2", appBundlePath], {
      encoding: "utf8",
      timeout: 4_000,
    });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (/Signature=adhoc/i.test(text) || /flags=0x[0-9a-f]*\(adhoc/i.test(text)) {
      return "adhoc";
    }
    if (/Authority=/i.test(text)) {
      return "signed";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveMacUpdaterZipPath(updaterCacheDirName: string): string {
  return NodePath.join(NodeOs.homedir(), "Library/Caches", updaterCacheDirName, "update.zip");
}

export function macUpdaterZipReady(zipPath: string): boolean {
  try {
    return NodeFs.statSync(zipPath).isFile() && NodeFs.statSync(zipPath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Launch a detached helper that waits for `pid` to exit, replaces the app
 * bundle from `updateZipPath`, and reopens it. Returns false if the helper
 * could not be started.
 */
export function spawnMacAdhocReplaceAndRelaunch(input: {
  readonly appBundlePath: string;
  readonly updateZipPath: string;
  readonly pid: number;
}): boolean {
  const script = `
set -euo pipefail
APP=${JSON.stringify(input.appBundlePath)}
ZIP=${JSON.stringify(input.updateZipPath)}
PID=${JSON.stringify(String(input.pid))}
TMP="$(mktemp -d "\${TMPDIR:-/tmp}/t3code-adhoc-update.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Wait for the running app to fully exit so we can replace the bundle.
for _ in $(seq 1 150); do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
if kill -0 "$PID" 2>/dev/null; then
  echo "timed out waiting for pid $PID to exit" >&2
  exit 1
fi
sleep 0.4

unzip -q "$ZIP" -d "$TMP"
NEW_APP="$(find "$TMP" -maxdepth 1 -name '*.app' -type d | head -n 1)"
if [ -z "\${NEW_APP}" ]; then
  echo "update zip did not contain an .app bundle" >&2
  exit 1
fi

PARENT="$(dirname "$APP")"
mkdir -p "$PARENT"
# Stage next to the target, then swap atomically-ish.
STAGED="$PARENT/.t3code-update-staging.app"
rm -rf "$STAGED"
ditto "$NEW_APP" "$STAGED"
rm -rf "$APP"
mv "$STAGED" "$APP"
open "$APP"
`;

  try {
    const child = NodeChildProcess.spawn("/bin/bash", ["-lc", script], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
