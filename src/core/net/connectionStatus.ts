import { getInternetTransportSingleton } from '../transport/internet/internetTransport';

/**
 * Состояние связи, показываемое человеку (v4.32.610).
 *
 * До этой версии приложение молчало о двух самых заметных для человека
 * состояниях. Пока сокет ретранслятора переподключался (экспоненциальный
 * откат 2→30 секунд после каждого обрыва), отправленное просто не уходило;
 * пока шла синхронизация аккаунта после запуска, переписка и лента стояли
 * неполными. Ни то ни другое ничем не отличалось от поломки: экран выглядел
 * ровно так же, как при исправной связи, — и человек жал «отправить» второй
 * раз или уходил перезапускать приложение.
 *
 * Здесь появляются два слова, которых не хватало: «Соединение…» и
 * «Обновление…». Решение о том, какое из них показать, вынесено в чистые
 * функции: полоска состояния — то место, где ошибка выражается в лишнем
 * мигании на каждом экране, поэтому правило обязано проверяться тестом, а не
 * глазами.
 */

/** Состояние подписки на ретранслятор. `off` — транспорт не запущен вовсе. */
export type RelayPhase = 'off' | 'connecting' | 'online';

/** Что показать в полоске. `idle` — не показывать ничего. */
export type LiveStatus = 'idle' | 'connecting' | 'updating';

/**
 * Сколько состояние должно продержаться, прежде чем о нём скажут вслух.
 *
 * Обрыв сокета длиной в полсекунды — обычное дело на мобильной сети, и
 * полоска, мигающая на каждом таком обрыве, сдвигает содержимое экрана и
 * читается как неисправность. Задержка нужна именно затем, чтобы говорить
 * только о том, что человек и так успел заметить.
 *
 * У «Обновления…» порог ниже: синхронизация редко бывает мгновенной, а
 * молчание во время неё — та самая пустая лента без объяснения.
 */
export const STATUS_GRACE_MS: Record<Exclude<LiveStatus, 'idle'>, number> = {
  connecting: 1_500,
  updating: 900,
};

/**
 * Что происходит прямо сейчас, без учёта задержки.
 *
 * Порядок ветвей не косметический: пока связи нет, «Обновление…» — неправда.
 * Синхронизация в этот момент никуда не идёт, и назвать её идущей значит
 * пообещать человеку, что данные вот-вот приедут.
 */
export function rawStatus(input: { relay: RelayPhase; syncing: boolean }): LiveStatus {
  if (input.relay === 'connecting') return 'connecting';
  if (input.syncing) return 'updating';
  return 'idle';
}

/** Показать ли состояние, продержавшееся `heldMs` миллисекунд. */
export function settledStatus(raw: LiveStatus, heldMs: number): LiveStatus {
  if (raw === 'idle') return 'idle';
  return heldMs >= STATUS_GRACE_MS[raw] ? raw : 'idle';
}

/**
 * Состояние подписки на ретранслятор.
 *
 * Транспорт помечен `@stable` и подписки на смену состояния не отдаёт, зато
 * отдаёт `getStatus()` — чистое чтение двух флагов. Поэтому опрашиваем его,
 * а не переписываем то, от чего зависит вся доставка.
 */
export function readRelayPhase(): RelayPhase {
  const s = getInternetTransportSingleton().getStatus();
  if (!s.active) return 'off';
  return s.wsOpen ? 'online' : 'connecting';
}

let syncDepth = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Синхронизация аккаунта началась. Счётчик, а не флаг: заходов может быть
 * несколько (запуск, возвращение сети, переключение профиля), и первый же
 * закончившийся не должен гасить полоску за остальных.
 */
export function markAccountSyncStart(): void {
  syncDepth += 1;
  if (syncDepth === 1) notify();
}

export function markAccountSyncEnd(): void {
  if (syncDepth === 0) return;
  syncDepth -= 1;
  if (syncDepth === 0) notify();
}

export function isAccountSyncActive(): boolean {
  return syncDepth > 0;
}

export function subscribeAccountSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Только для тестов: вернуть счётчик в исходное состояние. */
export function resetAccountSyncForTests(): void {
  syncDepth = 0;
}
