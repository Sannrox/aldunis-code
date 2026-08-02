import type {
  ProviderBrowserObservation,
  ProviderEvent,
  ProviderId,
} from "./provider.ts";

/** Keep provider-owned observations small enough to remain an ephemeral UI event. */
export const MAX_BROWSER_OBSERVATION_BYTES = 512_000;

const BROWSER_IMAGE_TYPES = new Set<ProviderBrowserObservation["mediaType"]>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URI = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0")
    ? value
    : null;
}

function safeLocation(value: unknown): string | null {
  const raw = boundedString(value, 2_048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    // Query strings and fragments often carry tokens or user data. The image is
    // the observation; location is only a short, non-sensitive orientation hint.
    return `${url.origin}${url.pathname}`.slice(0, 1_024);
  } catch {
    return null;
  }
}

function imageData(
  image: unknown,
  mediaType: unknown,
): { imageData: string; mediaType: ProviderBrowserObservation["mediaType"] } | null {
  if (typeof image !== "string" || image.length === 0) return null;
  const uri = image.match(DATA_URI);
  if (uri) {
    const type = uri[1] as ProviderBrowserObservation["mediaType"];
    if (uri[2].length % 4 !== 0 || uri[2].length === 0) return null;
    if (uri[0].length > MAX_BROWSER_OBSERVATION_BYTES || !BROWSER_IMAGE_TYPES.has(type)) return null;
    return { imageData: uri[0], mediaType: type };
  }
  if (
    typeof mediaType !== "string"
    || !BROWSER_IMAGE_TYPES.has(mediaType as ProviderBrowserObservation["mediaType"])
    || image.length % 4 !== 0
    || image.length > MAX_BROWSER_OBSERVATION_BYTES
    || !BASE64.test(image)
  ) return null;
  const type = mediaType as ProviderBrowserObservation["mediaType"];
  const dataUri = `data:${type};base64,${image}`;
  if (dataUri.length > MAX_BROWSER_OBSERVATION_BYTES) return null;
  return { imageData: dataUri, mediaType: type };
}

/**
 * Normalize an adapter-owned image payload into the only browser-view event
 * the host accepts. Invalid or unbounded payloads are ignored rather than
 * promoted to a provider protocol failure.
 */
export function normalizeBrowserObservation(input: {
  provider: ProviderId;
  observationId: unknown;
  image?: unknown;
  imageData?: unknown;
  data?: unknown;
  mediaType?: unknown;
  mimeType?: unknown;
  url?: unknown;
  title?: unknown;
  toolCallId?: unknown;
}): Extract<ProviderEvent, { kind: "browser_observation" }> | null {
  const observationId = boundedString(input.observationId, 200);
  const parsed = imageData(
    input.imageData ?? input.image ?? input.data,
    input.mediaType ?? input.mimeType,
  );
  if (!observationId || !parsed) return null;
  const toolCallId = boundedString(input.toolCallId, 200);
  const title = boundedString(input.title, 240);
  const url = safeLocation(input.url);
  return {
    kind: "browser_observation",
    provider: input.provider,
    observationId,
    imageData: parsed.imageData,
    mediaType: parsed.mediaType,
    ...(toolCallId ? { toolCallId } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
  };
}
