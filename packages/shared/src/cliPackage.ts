export const DEFAULT_CLI_PACKAGE_NAME = "t3";

export function normalizeCliPackageName(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CLI_PACKAGE_NAME;
}

export function formatCliPackageSpec(packageName: string, versionOrTag: string): string {
  return `${normalizeCliPackageName(packageName)}@${versionOrTag}`;
}

export function cliPackageNodeModulesSegments(packageName: string): readonly string[] {
  return normalizeCliPackageName(packageName).split("/");
}
