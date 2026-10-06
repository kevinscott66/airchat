/** Native build configuration. Expo embeds this value in the native client. */
export function bundledOpenFluxDocument(): string {
  return typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_OPENFLUX_DOC_URL
    ? process.env.EXPO_PUBLIC_OPENFLUX_DOC_URL
    : '';
}
