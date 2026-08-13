import { constants } from "node:fs";
import { access } from "node:fs/promises";
import {
  delimiter,
  isAbsolute,
  join,
  normalize,
  parse as parsePath,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  adapterDigest,
  MAX_MANIFEST_BYTES,
  parseProviderAdapterManifest,
  ProviderAdapterError,
  type InstalledProviderAdapter,
  type ProviderAdapterManifest,
  ProviderAdapterStore,
  readProviderAdapterRecordFile,
} from "./provider-adapters.ts";

/** Reviewed, first-party manifests shipped with Aldunis Code. */
const REVIEWED_ADAPTER_FILES = [
  {
    slug: "kiro-cli",
    installLabel: "Install Kiro CLI",
    updateLabel: "Review Kiro CLI update",
    requiresCliHint: "Install the Kiro CLI and ensure `kiro-cli` is on PATH.",
    websiteFallback: "https://kiro.dev/docs/cli/acp/",
  },
  {
    slug: "grok-build-cli",
    installLabel: "Install Grok Build CLI",
    updateLabel: "Review Grok Build update",
    requiresCliHint: "Install the Grok Build CLI and ensure `grok` is on PATH.",
    websiteFallback: "https://x.ai/cli",
  },
  {
    slug: "opencode-cli",
    installLabel: "Install OpenCode",
    updateLabel: "Review OpenCode update",
    requiresCliHint: "Install the OpenCode CLI and ensure `opencode` is on PATH.",
    websiteFallback: "https://opencode.ai/docs/acp/",
  },
] as const;

export type ReviewedAdapterSlug = (typeof REVIEWED_ADAPTER_FILES)[number]["slug"];

export interface ReviewedAdapterCatalogEntry {
  slug: ReviewedAdapterSlug;
  id: string;
  name: string;
  description: string;
  website: string | null;
  version: string;
  digest: string;
  source: string;
  executableNames: string[];
  executableFound: boolean;
  executablePath: string | null;
  installed: boolean;
  installedVersion: string | null;
  installedDigest: string | null;
  enabled: boolean | null;
  action: "install" | "update" | "reinstall-same" | "current";
  installLabel: string;
  requiresCliHint: string;
  /** Ready for inspect/install — same shape the manual form submits. */
  package: {
    source: string;
    digest: string;
    manifest: ProviderAdapterManifest;
  };
}

function reviewedAdaptersDirectory(): string {
  // server/reviewed-adapters.ts → ../provider-adapters
  return resolve(fileURLToPath(new URL("../provider-adapters", import.meta.url)));
}

async function findExecutableOnPath(names: string[]): Promise<string | null> {
  const allowed = new Set(names);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const root = resolve(directory);
    for (const name of allowed) {
      const candidate = normalize(join(root, name));
      const relative = candidate.slice(root.length);
      if (!(relative.startsWith(sep) && !relative.slice(1).includes(sep))) continue;
      if (!allowed.has(parsePath(candidate).base)) continue;
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return null;
}

async function loadReviewedPackage(slug: ReviewedAdapterSlug): Promise<{
  source: string;
  digest: string;
  manifest: ProviderAdapterManifest;
  expectedDigest: string;
}> {
  const directory = reviewedAdaptersDirectory();
  const manifestPath = join(directory, `${slug}.json`);
  const digestPath = join(directory, `${slug}.sha256`);
  let raw: string;
  let expectedDigest: string;
  try {
    raw = await readProviderAdapterRecordFile(manifestPath, undefined, MAX_MANIFEST_BYTES);
    expectedDigest = (
      await readProviderAdapterRecordFile(digestPath, undefined, MAX_MANIFEST_BYTES)
    ).trim();
  } catch {
    throw new ProviderAdapterError(
      `The reviewed ${slug} adapter package is missing from this Aldunis install.`,
      500,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(expectedDigest)) {
    throw new ProviderAdapterError(`The reviewed ${slug} digest file is malformed.`, 500);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderAdapterError(`The reviewed ${slug} manifest is not valid JSON.`, 500);
  }
  const manifest = parseProviderAdapterManifest(parsed);
  const digest = adapterDigest(manifest);
  if (digest !== expectedDigest) {
    throw new ProviderAdapterError(
      `The reviewed ${slug} manifest does not match its pinned digest.`,
      500,
    );
  }
  const source = pathToFileURL(manifestPath).href;
  return { source, digest, manifest, expectedDigest };
}

function resolveAction(
  installed: InstalledProviderAdapter | null,
  catalogVersion: string,
  catalogDigest: string,
): ReviewedAdapterCatalogEntry["action"] {
  if (!installed) return "install";
  if (installed.digest === catalogDigest && installed.manifest.version === catalogVersion) {
    return "current";
  }
  // Updates require a higher semver; otherwise offer reinstall of the reviewed package.
  const compare = (left: string, right: string): number => {
    const parts = (value: string) =>
      value.split(".").map((part) => Number(part.replace(/\D.*/, "")) || 0);
    const a = parts(left);
    const b = parts(right);
    for (let i = 0; i < 3; i += 1) {
      const delta = (a[i] ?? 0) - (b[i] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  };
  if (compare(catalogVersion, installed.manifest.version) > 0) return "update";
  if (installed.digest !== catalogDigest) return "reinstall-same";
  return "current";
}

export async function listReviewedAdapters(
  adapters: ProviderAdapterStore,
): Promise<ReviewedAdapterCatalogEntry[]> {
  const installed = await adapters.list();
  const byId = new Map(installed.map((item) => [item.manifest.id, item]));
  const entries: ReviewedAdapterCatalogEntry[] = [];

  for (const definition of REVIEWED_ADAPTER_FILES) {
    const pack = await loadReviewedPackage(definition.slug);
    const current = byId.get(pack.manifest.id) ?? null;
    const executablePath = await findExecutableOnPath(pack.manifest.executable.names);
    const action = resolveAction(current, pack.manifest.version, pack.digest);
    entries.push({
      slug: definition.slug,
      id: pack.manifest.id,
      name: pack.manifest.presentation.name,
      description: pack.manifest.presentation.description,
      website: pack.manifest.presentation.website ?? definition.websiteFallback,
      version: pack.manifest.version,
      digest: pack.digest,
      source: pack.source,
      executableNames: [...pack.manifest.executable.names],
      executableFound: executablePath !== null,
      executablePath,
      installed: current !== null,
      installedVersion: current?.manifest.version ?? null,
      installedDigest: current?.digest ?? null,
      enabled: current?.enabled ?? null,
      action,
      installLabel:
        action === "update" || action === "reinstall-same"
          ? definition.updateLabel
          : definition.installLabel,
      requiresCliHint: definition.requiresCliHint,
      package: {
        source: pack.source,
        digest: pack.digest,
        manifest: pack.manifest,
      },
    });
  }

  return entries;
}

export async function prepareReviewedAdapter(
  adapters: ProviderAdapterStore,
  slug: unknown,
): Promise<{
  entry: ReviewedAdapterCatalogEntry;
  candidate: InstalledProviderAdapter;
}> {
  if (typeof slug !== "string" || !REVIEWED_ADAPTER_FILES.some((item) => item.slug === slug)) {
    throw new ProviderAdapterError("Unknown reviewed adapter.", 404);
  }
  const entries = await listReviewedAdapters(adapters);
  const entry = entries.find((item) => item.slug === slug);
  if (!entry) throw new ProviderAdapterError("Unknown reviewed adapter.", 404);
  const candidate = adapters.inspect(entry.package);
  return { entry, candidate };
}
