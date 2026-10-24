/** Native build configuration. Expo embeds this value in the native client. */
export function bundledOpenFluxDocument(): string {
  return typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_OPENFLUX_DOC_URL
    ? process.env.EXPO_PUBLIC_OPENFLUX_DOC_URL
    : '';
}

/** Private native build input: exact previous factory documents, never user URLs. */
export function previousBundledOpenFluxDocuments(): string[] {
  const raw = typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_OPENFLUX_PREVIOUS_DOC_URLS : undefined;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((url) => typeof url === 'string' && url.length > 0)
      ? parsed
      : [];
  } catch {
    return [];
  }
}
