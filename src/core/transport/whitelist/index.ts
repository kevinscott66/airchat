/**
 * Образовательный модуль: зашифрованный транспорт через сервисы из белого списка.
 * По умолчанию выключен в конфиге (`whitelist.enabled`).
 */
export { deriveWhitelistSymmetricKey, encryptWhitelistUtf8, decryptWhitelistUtf8 } from './whitelistCrypto';
export {
  EncryptedWhitelistTransport,
  type EncryptedWhitelistPayloadV1,
} from './EncryptedWhitelistTransport';
export { YandexDiskTransport, type YandexDiskConfig } from './YandexDiskTransport';
export { VKTransport, type VKConfig } from './VKTransport';
export { MailRuTransport, type MailRuConfig } from './MailRuTransport';
export { createWhitelistTransport, type WhitelistKind } from './factory';
