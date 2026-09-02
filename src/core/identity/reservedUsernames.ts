/**
 * Юзернеймы, которые нельзя занять самому (v4.32.540).
 *
 * До этой версии правило было одно: 3–32 символа из `[a-z0-9_]`, и кто первым
 * успел — того и имя. Два следствия.
 *
 * Первое: короткие и «ролевые» имена — `owner`, `admin`, `support`, `airchat`
 * — уходили первому попавшемуся. Имя `support` у постороннего человека это не
 * вопрос вкуса: оно само по себе выглядит как служебный адрес приложения, и
 * ровно так им и пользуются, когда просят чужие коды подтверждения.
 *
 * Второе: экран профиля показывал ОДНУ ошибку на все случаи сразу — «занят или
 * не сохранён». Человек, набравший имя из двух букв, читал про занятость, шёл
 * подбирать варианты и получал тот же ответ на каждый. Причина отказа теперь
 * возвращается отдельным значением, и текст к нему пишет экран.
 *
 * Нижний предел САМОСТОЯТЕЛЬНОГО занятия (`USERNAME_MIN_SELF_SERVICE`) выше
 * протокольного (`USERNAME_MIN`) намеренно. Протокольный остаётся прежним:
 * короткие имена существуют — они выданы приложением, — и чужой конверт с
 * таким именем мы обязаны принять и показать, а не отбросить как испорченный.
 * Ограничение стоит только на своём поле ввода.
 */
import { normalizeUsername, USERNAME_MIN, USERNAME_MAX } from './username';

/** Короче этого юзернейм себе не занять: такие имена оставлены приложению. */
export const USERNAME_MIN_SELF_SERVICE = 5;

/**
 * Занятые имена. Список намеренно шире очевидного:
 *
 * - служебные роли и обращения к поддержке — их путают с адресами приложения;
 * - имя самого приложения и его разделов — по ним человек ищет официальный
 *   аккаунт;
 * - денежные и «подарочные» слова — обычная вывеска мошеннической рассылки.
 *
 * Хранится в нижнем регистре: сравнение идёт после `normalizeUsername`.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
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

/** Почему юзернейм не приняли. Текст к причине пишет экран. */
export type UsernameRejection = 'empty' | 'charset' | 'too_short' | 'too_long' | 'reserved';

export type UsernameClaim =
  | { ok: true; username: string }
  | { ok: false; reason: UsernameRejection };

/**
 * Проверка своего поля ввода. Возвращает причину отказа, а не один `null`:
 * «короче пяти символов» и «имя оставлено приложению» — разные разговоры с
 * человеком, и подсказать по ним можно разное.
 */
export function checkUsernameClaim(value: unknown): UsernameClaim {
  const raw = typeof value === 'string' ? value.trim().replace(/^@+/, '').toLowerCase() : '';
  if (!raw) return { ok: false, reason: 'empty' };
  if (!/^[a-z0-9_]+$/.test(raw)) return { ok: false, reason: 'charset' };
  if (raw.length > USERNAME_MAX) return { ok: false, reason: 'too_long' };
  // Порядок важен: `nft` короче предела И зарезервирован. Про длину человеку
  // сказать полезнее — это подсказка, что делать дальше.
  if (raw.length < USERNAME_MIN_SELF_SERVICE) return { ok: false, reason: 'too_short' };
  if (RESERVED_USERNAMES.has(raw)) return { ok: false, reason: 'reserved' };
  // Последним словом — общий нормализатор: границы протокола должны совпасть.
  const normalized = normalizeUsername(raw);
  if (!normalized) return { ok: false, reason: 'charset' };
  return { ok: true, username: normalized };
}

/** Занято ли имя приложением. Для чужих юзернеймов — только справка. */
export function isReservedUsername(value: unknown): boolean {
  const raw = normalizeUsername(value);
  return raw !== null && RESERVED_USERNAMES.has(raw);
}

/** Нижняя граница протокола — чтобы её не пришлось повторять в экранах. */
export { USERNAME_MIN, USERNAME_MAX };
