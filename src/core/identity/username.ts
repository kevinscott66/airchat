/** Канонический username аккаунта. Отображаемое имя от него не зависит. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

/**
 * Нормализует username перед записью и перед сравнением.
 * `null` означает, что значение не является допустимым username.
 */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]+$/.test(normalized)) return null;
  if (normalized.length < USERNAME_MIN || normalized.length > USERNAME_MAX) return null;
  return normalized;
}

export function isValidUsername(value: unknown): value is string {
  return normalizeUsername(value) !== null;
}
