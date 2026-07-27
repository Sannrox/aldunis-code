import type { Product } from "../types";

export type ProductAvailability = Record<Product, boolean>;

/** Default until the host reports configured plane endpoints. */
export const DEFAULT_PRODUCT_AVAILABILITY: ProductAvailability = {
  code: true,
  sekai: false,
  chisei: false,
  tenkai: false,
};

export function isProductAvailable(
  product: Product,
  availability: ProductAvailability,
): boolean {
  return availability[product] === true;
}

export function readProductAvailabilityResponse(value: unknown): ProductAvailability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const products = ["code", "sekai", "chisei", "tenkai"] as const;
  const next = { ...DEFAULT_PRODUCT_AVAILABILITY };
  for (const id of products) {
    if (typeof body[id] !== "boolean") return null;
    next[id] = body[id] as boolean;
  }
  // Code is never unavailable.
  next.code = true;
  return next;
}
