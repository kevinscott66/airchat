/**
 * Запись в SecureStore есть, но прочитать её нельзя.
 *
 * AC-03. Веб-реализация (`secureStoreQueued.web`) прежде отвечала `null` и на
 * «записи нет», и на «запись есть, но не расшифровалась / не того формата».
 * Все, кто различает `absent` и `unreadable` (keyManager, seedPhrase,
 * localEncryption, syncApi), различают их именно по наличию строки: `null`
 * значит «можно заводить заново». На нечитаемой записи это превращало отказ
 * ЧТЕНИЯ в необратимую ЗАПИСЬ — новая личность, новый ключ устройства поверх
 * старых.
 *
 * Контракт теперь тот же, что у нативного expo-secure-store: отсутствие — это
 * `null`, а запись, которую не удалось открыть, — исключение. Нативный модуль
 * на сбросе Keystore / запертом Keychain тоже бросает, поэтому вызывающий код,
 * уже умеющий отличать «бросило» от «нет», ничего нового учить не должен.
 * Шифротекст при этом не удаляется и не перезаписывается: вдруг починится.
 *
 * Модуль без импортов: его тянут и нативная, и веб-реализация, и keyManager —
 * последний напрямую, чтобы не зависеть от моков `secureStoreQueued` в тестах.
 */

/** Почему запись не читается. Ни одна из причин не значит «записи нет». */
export type SecureStoreUnreadableReason =
  /** Лежит не то, что пишет setItemAsync: другой формат, обрезанная запись. */
  | 'malformed'
  /** Формат правильный, но AES-GCM запись не открыл: чужой ключ или порча. */
  | 'decrypt_failed'
  /** Запись есть, а мастер-ключа, которым она зашифрована, нет или он негоден. */
  | 'master_key_unusable';

export class SecureStoreUnreadableError extends Error {
  /** Ключ записи — как его передал вызывающий, без пространства имён. */
  readonly key: string;
  readonly reason: SecureStoreUnreadableReason;
  constructor(key: string, reason: SecureStoreUnreadableReason) {
    super(`Запись хранилища ключей «${key}» есть, но не читается (${reason}).`);
    this.name = 'SecureStoreUnreadableError';
    this.key = key;
    this.reason = reason;
  }
}

/**
 * Проверка без `instanceof`: модуль ошибки может оказаться загружен дважды
 * (изолированные модули в тестах, разные чанки бандла), и тогда классы у
 * брошенного и проверяющего разные.
 */
export function isSecureStoreUnreadable(e: unknown): e is SecureStoreUnreadableError {
  return (
    e instanceof SecureStoreUnreadableError ||
    (e instanceof Error && e.name === 'SecureStoreUnreadableError' && typeof (e as { key?: unknown }).key === 'string')
  );
}
