/**
 * Cross-product plane availability for the brand/product switcher.
 * Planes other than Code are unavailable until an explicit endpoint is configured.
 */

export type ProductId = "code" | "sekai" | "chisei" | "tenkai";

export type ProductAvailability = Record<ProductId, boolean>;

/** Env vars that enable each plane (non-empty = configured). */
export const PRODUCT_ENDPOINT_ENV: Record<Exclude<ProductId, "code">, string> = {
  sekai: "ALDUNIS_SEKAI_ENDPOINT",
  chisei: "ALDUNIS_CHISEI_ENDPOINT",
  tenkai: "ALDUNIS_TENKAI_ENDPOINT",
};

/** Hosted Shikigami governance endpoint also enables the Chisei plane. */
export const CHISEI_GOVERNANCE_ENDPOINT_ENV = "ALDUNIS_MANAGED_SHIKIGAMI_GOVERNANCE_ENDPOINT";

function endpointConfigured(name: string, env: NodeJS.ProcessEnv): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve which products the UI may switch into.
 * Code is always available. Other planes require a configured endpoint.
 */
export function resolveProductAvailability(
  env: NodeJS.ProcessEnv = process.env,
): ProductAvailability {
  return {
    code: true,
    sekai: endpointConfigured(PRODUCT_ENDPOINT_ENV.sekai, env),
    chisei:
      endpointConfigured(PRODUCT_ENDPOINT_ENV.chisei, env) ||
      endpointConfigured(CHISEI_GOVERNANCE_ENDPOINT_ENV, env),
    tenkai: endpointConfigured(PRODUCT_ENDPOINT_ENV.tenkai, env),
  };
}
