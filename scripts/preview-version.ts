import { pathToFileURL } from "node:url";

const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const UTC_DATE = /^\d{8}$/u;
const RUN_NUMBER = /^[1-9]\d*$/u;

function requireMatch(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

export function nightlyVersion(baseVersion: string, utcDate: string, runNumber: string | number): string {
  const base = requireMatch(baseVersion, STABLE_VERSION, "The base package version");
  const date = requireMatch(utcDate, UTC_DATE, "The UTC build date");
  const run = requireMatch(String(runNumber), RUN_NUMBER, "The workflow run number");
  return `${base}-nightly.${date}.${run}`;
}

export function previewTag(version: string): string {
  if (!/^\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/u.test(version)) {
    throw new Error("The preview version is invalid.");
  }
  return `preview-v${version}`;
}

async function main(): Promise<void> {
  const [baseVersion, utcDate, runNumber] = process.argv.slice(2);
  if (!baseVersion || !utcDate || !runNumber) {
    throw new Error("Usage: preview-version <base-version> <utc-yyyymmdd> <run-number>");
  }
  const version = nightlyVersion(baseVersion, utcDate, runNumber);
  process.stdout.write(`${version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
