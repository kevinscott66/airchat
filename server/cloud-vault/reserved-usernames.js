/**
 * Зеркало клиентского списка занятых имён (`src/core/identity/reservedUsernames.ts`).
 *
 * Реестр имён — общий на всё приложение, и последнее слово в нём за сервером:
 * клиент можно пересобрать, отключить проверку и попросить себе `support`.
 * Поэтому те же правила стоят и здесь — длина, набор символов, список
 * оставленных приложению имён. Список продублирован намеренно: сервер живёт в
 * отдельном процессе на CommonJS и не собирается вместе с приложением.
 * Расхождение ловит тест `username-registry.test.js`, который читает исходник
 * клиента и сверяет оба множества.
 */
const USERNAME_MIN_SELF_SERVICE = 5;
const USERNAME_MAX = 32;

const RESERVED_USERNAMES = new Set([
  // приложение и его разделы
  'airchat', 'air', 'chat', 'chats', 'app', 'news', 'feed', 'group', 'groups',
  'channel', 'channels', 'story', 'stories', 'call', 'calls', 'settings',
  'profile', 'profiles', 'account', 'accounts', 'wallet', 'wallets',
  // роли и служебные адреса
  'owner', 'founder', 'admin', 'admins', 'administrator', 'root', 'system',
  'sys', 'staff', 'team', 'mod', 'mods', 'moderator', 'moderators',
  'support', 'help', 'helpdesk', 'service', 'security', 'abuse', 'legal',
  'official', 'verify', 'verified', 'verification', 'noreply', 'no_reply',
  'postmaster', 'webmaster', 'hostmaster', 'operator', 'bot', 'bots',
  // денежные и «подарочные» вывески
  'gift', 'gifts', 'giveaway', 'airdrop', 'bonus', 'promo', 'reward',
  'rewards', 'nft', 'nfts', 'crypto', 'coin', 'coins', 'token', 'tokens',
  'pay', 'payment', 'payments', 'billing', 'invoice', 'bank', 'shop',
  'store', 'market', 'sale', 'deal', 'deals',
  // обращения ко всем
  'me', 'you', 'all', 'everyone', 'anyone', 'nobody', 'null', 'undefined',
  'test', 'demo', 'example',
]);

/**
 * Приводит имя к каноническому виду и отвергает всё, что нельзя занять.
 * Возвращает нормализованное имя либо `null` — причину сервер не называет:
 * подробный разбор ошибки человеку показывает экран, который проверил то же
 * самое до отправки.
 */
function normalizeClaimableUsername(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]+$/.test(raw)) return null;
  if (raw.length < USERNAME_MIN_SELF_SERVICE || raw.length > USERNAME_MAX) return null;
  if (RESERVED_USERNAMES.has(raw)) return null;
  return raw;
}

/** Имя для справочного запроса: занятость можно спросить и про короткое имя. */
function normalizeLookupUsername(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(raw)) return null;
  return raw;
}

module.exports = {
  RESERVED_USERNAMES,
  USERNAME_MIN_SELF_SERVICE,
  USERNAME_MAX,
  normalizeClaimableUsername,
  normalizeLookupUsername,
};
