/**
 * Pure helpers for /api/providers/discover payloads.
 * Presentation-only: run authorization still enforces readiness at start.
 */

export function declarativeAdapterReadiness(options: {
  name: string;
  enabled: boolean;
  executableFound: boolean;
  executableNames: string[];
  missingRequiredEnv: string[];
}): { authenticated: boolean; detail: string | null } {
  const { name, enabled, executableFound, executableNames, missingRequiredEnv } = options;
  if (!enabled) {
    return {
      authenticated: false,
      detail: `${name} is disabled in Provider adapters.`,
    };
  }
  if (!executableFound) {
    const binaries = executableNames.length > 0
      ? executableNames.join(" or ")
      : "the adapter CLI";
    return {
      authenticated: false,
      detail: `Install ${binaries} on PATH for ${name}.`,
    };
  }
  if (missingRequiredEnv.length > 0) {
    return {
      authenticated: false,
      detail: `Set required env for ${name}: ${missingRequiredEnv.join(", ")}.`,
    };
  }
  return { authenticated: true, detail: null };
}
