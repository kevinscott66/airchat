import { isWithinDndWindow, parseDndHour } from './dndWindow';
import { isMuteActive, muteKey } from '../core/notifications/muteValue';
import { profileScopedKey } from '../core/storage/kvKeys';
import type { PushKind } from './pushKind';

/**
 * Настройки уведомлений для фонового обработчика push.
 *
 * v4.32.248. До этой версии фоновый обработчик не спрашивал настройки вообще:
 * «Уведомления о сообщениях» выключены, идёт «Не беспокоить», звук и вибрация
 * отключены — баннер всё равно приходил со звуком. То есть настройки работали
 * ровно тогда, когда приложение открыто, — когда они меньше всего нужны.
 *
 * Почему тут своё чтение базы, а не kvGet из core/storage/local: фоновый
 * обработчик живёт в отдельном контексте, который поднимается на каждый push,
 * и импорт слоя хранилища потянул бы за собой миграции схемы, профили и
 * транспорт. Здесь — одно чтение из уже существующей таблицы kv, и любая
 * ошибка означает «показать уведомление»: молчаливо съесть сообщение хуже,
 * чем показать его вопреки настройке.
 *
 * v4.32.572. Выключатель был один на всё: «Личные сообщения». Сообщение в
 * группе едет тем же конвертом, что и личное, поэтому выключенные личные
 * глушили и группы, а выключенные «Группы» при закрытом приложении не глушили
 * ничего — этот ключ отсюда не читался вовсе. Теперь вид сообщения приезжает
 * вместе с push (см. notifications/pushKind), и каждый вид спрашивает свой
 * выключатель.
 */

const LOCAL_DB_NAME = 'airchat_local.db';

/**
 * Зеркало номера активного профиля (пишет profileManager при каждой записи
 * состояния). Записи «без звука» лежат в namespace профиля — `p<id>:mute:…`, —
 * а фоновому обработчику номер спросить не у кого: profileManager держит его в
 * SecureStore и поднимается вместе со всем слоем хранилища. Зеркало в kv —
 * ровно один целый номер, читается тем же запросом, что и остальные настройки.
 */
const ACTIVE_PROFILE_MIRROR_KEY = 'active_profile_id';

export type BackgroundNotifyPrefs = {
  /** Показывать ли баннер вообще. */
  show: boolean;
  sound: boolean;
  vibrate: boolean;
};

const ALLOW_ALL: BackgroundNotifyPrefs = { show: true, sound: true, vibrate: true };

/**
 * Читает только те ключи, что нужны баннеру. Отсутствующий ключ означает
 * согласие: настройка по умолчанию — уведомления включены.
 */
export async function readBackgroundNotifyPrefs(
  kind: PushKind = 'dm',
  nowHour: number = new Date().getHours()
): Promise<BackgroundNotifyPrefs> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SQLite = require('expo-sqlite') as typeof import('expo-sqlite');
    const db = await SQLite.openDatabaseAsync(LOCAL_DB_NAME);
    const rows = await db.getAllAsync<{ k: string; v: string }>(
      "SELECT k, v FROM kv WHERE k IN ('notify_dm','notify_groups','notify_sound','notify_vibrate','dnd_enabled','dnd_start','dnd_end')"
    );
    const kv = new Map(rows.map((r) => [r.k, r.v]));
    const toggle = kind === 'group' ? 'notify_groups' : 'notify_dm';
    if (kv.get(toggle) === 'false') return { show: false, sound: false, vibrate: false };
    if (kv.get('dnd_enabled') === 'true') {
      const start = parseDndHour(kv.get('dnd_start'), 22);
      const end = parseDndHour(kv.get('dnd_end'), 8);
      if (isWithinDndWindow(start, end, nowHour)) return { show: false, sound: false, vibrate: false };
    }
    return {
      show: true,
      sound: kv.get('notify_sound') !== 'false',
      vibrate: kv.get('notify_vibrate') !== 'false',
    };
  } catch {
    // База ещё не создана (первый запуск) или недоступна из фона — показываем.
    return ALLOW_ALL;
  }
}

/**
 * Настройки для баннера входящего звонка.
 *
 * v4.32.573. Звонок не сообщение, и общий выключатель сообщений его глушить не
 * должен: человек, отключивший баннеры переписки, не отказывался от звонков.
 * Свой выключатель у звонков — `notify_calls`, и отсутствие ключа означает
 * согласие, как и везде здесь.
 *
 * «Не беспокоить» звонок не прячет, а лишь обеззвучивает. Спрятать его совсем
 * значило бы съесть звонок молча: пропущенного звонка в AirChat нет, показать
 * его потом будет нечем, и человек не узнает, что ему звонили. Экран
 * поднимется без звука и вибрации — это честнее.
 */
export async function readBackgroundCallPrefs(
  nowHour: number = new Date().getHours()
): Promise<BackgroundNotifyPrefs> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SQLite = require('expo-sqlite') as typeof import('expo-sqlite');
    const db = await SQLite.openDatabaseAsync(LOCAL_DB_NAME);
    const rows = await db.getAllAsync<{ k: string; v: string }>(
      "SELECT k, v FROM kv WHERE k IN ('notify_calls','notify_sound','notify_vibrate','dnd_enabled','dnd_start','dnd_end')"
    );
    const kv = new Map(rows.map((r) => [r.k, r.v]));
    if (kv.get('notify_calls') === 'false') return { show: false, sound: false, vibrate: false };
    if (kv.get('dnd_enabled') === 'true') {
      const start = parseDndHour(kv.get('dnd_start'), 22);
      const end = parseDndHour(kv.get('dnd_end'), 8);
      if (isWithinDndWindow(start, end, nowHour)) return { show: true, sound: false, vibrate: false };
    }
    return {
      show: true,
      sound: kv.get('notify_sound') !== 'false',
      vibrate: kv.get('notify_vibrate') !== 'false',
    };
  } catch {
    // База ещё не создана или недоступна из фона — звонок показываем.
    return ALLOW_ALL;
  }
}

/**
 * Заглушён ли этот собеседник — для баннера, пришедшего при закрытом приложении.
 *
 * v4.32.502. Фоновый путь про «без звука» не знал вовсе: настройка глушила
 * баннеры ровно тогда, когда приложение открыто. Заглушённый собеседник
 * будил телефон ночью — то есть настройка не работала именно в том случае,
 * ради которого её и включают.
 *
 * Любая неясность решается в пользу показа: беззвучно проглотить сообщение
 * хуже, чем показать лишний баннер.
 */
export async function isBackgroundMuted(
  contactDid: string | undefined,
  now: number = Date.now()
): Promise<boolean> {
  if (!contactDid) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SQLite = require('expo-sqlite') as typeof import('expo-sqlite');
    const db = await SQLite.openDatabaseAsync(LOCAL_DB_NAME);
    const pidRow = await db.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', [
      ACTIVE_PROFILE_MIRROR_KEY,
    ]);
    const parsed = parseInt(pidRow?.v ?? '', 10);
    const pid = Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
    const logical = muteKey('chat', contactDid);
    const scoped = profileScopedKey(pid, logical);
    // Записи до v4.32.490 лежали без префикса и принадлежат первому профилю —
    // ровно то же правило, что у scopedKvTryGetFor. Переносить их отсюда
    // нельзя: фоновый контекст не имеет права на уборку чужого слоя.
    const legacy = logical;
    const keys = pid === 1 ? [scoped, legacy] : [scoped];
    const rows = await db.getAllAsync<{ k: string; v: string }>(
      `SELECT k, v FROM kv WHERE k IN (${keys.map(() => '?').join(',')})`,
      keys
    );
    const byKey = new Map(rows.map((r) => [r.k, r.v]));
    const raw = byKey.get(scoped) ?? (pid === 1 ? byKey.get(legacy) : undefined);
    return isMuteActive(raw, now);
  } catch {
    // База недоступна из фона — показываем, а не молчим.
    return false;
  }
}
