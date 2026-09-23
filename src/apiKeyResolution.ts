/** Resolve a request key across native BYOK, the live model registry, and cold-start storage. */
export function resolveResponseApiKey(
  configuredApiKey: string | undefined,
  registeredApiKey: string | undefined,
  storedApiKey: string | undefined,
): string | undefined {
  for (const candidate of [configuredApiKey, registeredApiKey, storedApiKey]) {
    const key = candidate?.trim();
    if (key) return key;
  }
  return undefined;
}
