import type { LambdaResponse } from "./types.js";
import { jsonResponse, GLOBAL_RATE_KEY } from "./config.js";
import { getItem, conditionalPut } from "./db.js";

interface RateLimitEntry {
  sentAt?: number;
  updatedAt?: number;
}

export async function checkAtomicGlobalRateLimit(limitMs: number): Promise<LambdaResponse | null> {
  const now = Date.now();

  const succeeded = await conditionalPut(
    {
      email: GLOBAL_RATE_KEY,
      recordType: "verification",
      sentAt: now,
      ttl: Math.floor(now / 1000) + 60,
    },
    "attribute_not_exists(sentAt) OR sentAt < :cutoff",
    { ":cutoff": now - limitMs },
  );

  if (succeeded) return null;

  const entry = await getItem<RateLimitEntry>(GLOBAL_RATE_KEY, "verification");
  const elapsed = now - (entry?.sentAt ?? 0);
  const waitSeconds = Math.ceil((limitMs - elapsed) / 1000);

  return jsonResponse(429, {
    error: `Please wait ${waitSeconds} seconds before requesting a new code`,
  });
}

export function checkTimestampRateLimit(
  timestamp: number | undefined,
  limitMs: number,
  message: string,
): LambdaResponse | null {
  if (!timestamp) return null;

  const elapsed = Date.now() - timestamp;
  if (elapsed >= limitMs) return null;

  const waitSeconds = Math.ceil((limitMs - elapsed) / 1000);
  return jsonResponse(429, { error: `Please wait ${waitSeconds} seconds ${message}` });
}

