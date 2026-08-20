import { normalizeCliPackageName } from "@t3tools/shared/cliPackage";

import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";

export interface CliPublishPackageSource {
  readonly name: string;
  readonly repository: {
    readonly type: string;
    readonly url: string;
    readonly directory: string;
  };
  readonly bin: Readonly<Record<string, string>>;
  readonly type: string;
  readonly version: string;
  readonly engines: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface CliPublishPackageManifest {
  readonly name: string;
  readonly repository: {
    readonly type: string;
    readonly url: string;
    readonly directory: string;
  };
  readonly bin: Readonly<Record<string, string>>;
  readonly type: string;
  readonly version: string;
  readonly engines: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly dependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
}

export function createPublishPackageManifest(input: {
  readonly source: CliPublishPackageSource;
  readonly version: string;
  readonly workspaceCatalog: Record<string, string>;
  readonly workspaceOverrides: Record<string, string>;
  readonly packageName?: string;
  readonly repositoryUrl?: string;
}): CliPublishPackageManifest {
  const repositoryUrl = input.repositoryUrl?.trim();
  return {
    name: normalizeCliPackageName(input.packageName ?? input.source.name),
    repository: {
      ...input.source.repository,
      ...(repositoryUrl ? { url: repositoryUrl } : {}),
    },
    bin: input.source.bin,
    type: input.source.type,
    version: input.version,
    engines: input.source.engines,
    files: input.source.files,
    dependencies: resolveCatalogDependencies(
      input.source.dependencies,
      input.workspaceCatalog,
      "apps/server",
    ),
    overrides: resolveCatalogDependencies(
      input.workspaceOverrides,
      input.workspaceCatalog,
      "apps/server",
    ),
  };
}
