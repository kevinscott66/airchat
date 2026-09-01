/**
 * v4.32.166: per-entity mute для уведомлений в стиле Telegram.
 *
 * Хранение: flat kvStore keys, префикс `mute:<kind>:<id>` — единообразно с
 * существующим нейминг-паттерном `notify_*` / `dnd_*` + доступен prefix-scan
 * через `kvListKeysByPrefix` для UI-списка «заглушённые».
 *
 * Значение:
 *   - `"1"`              — бессрочный mute (до явного unmute);
 *   - `"until:<epochMs>"` — snooze, автопродление до unmute по истечении.
 *
 * Expiry: ленивый. `isMuted()` читает значение, парсит `until:`, если
 * epochMs <= now() — удаляет ключ и возвращает false. Дополнительный sweep
 * по foreground — `sweepExpiredMutes()`.
 *
 * Scope: ключи лежат в namespace профиля (v4.32.490). Прежде не лежали, и
 * объяснялось это тем, что «mute — настройка устройства». Настройка устройства
 * — это звонить или вибрировать; а здесь в имени ключа стоит открытый ключ
 * собеседника, id группы или id публикации, то есть КОНКРЕТНЫЙ человек. Такой
 * человек бывает общим у двух аккаунтов на телефоне, и следствий было три:
 * заглушённый в одном аккаунте молчал и во втором, где его никто не глушил, —
 * то есть сообщения там пропадали беззвучно; список «Заглушённые» в настройках
 * показывал второму аккаунту людей, которых он не добавлял; а уборка при
 * удалении профиля (`p<id>:%`) эти записи не забирала и отдавала следующему
 * профилю с тем же номером.
 *
 * Форма id (v4.32.510): у вида `chat` записи лежат под did:key. Экраны
 * передают сюда открытый ключ в base64 — приведение делает keyFor, потому что
 * фоновый обработчик push другой формы собрать не может. Подробности —
 * muteChatId.
 */
import {
  scopedKvDelete,
  scopedKvGet,
  scopedKvListKeysByPrefix,
  scopedKvSet,
} from '../storage/profileScopedKv';
import { log } from '../logger';
import {
  MUTE_MAX_MS,
  muteExpired,
  muteKey,
  muteKeyPrefix,
  parseMuteKey,
  parseMuteValue,
} from './muteValue';
import type { MuteKind } from './muteValue';
import { canonicalMuteId, isCanonicalMuteId } from './muteChatId';

export type { MuteKind };

export type MuteEntry = {
  kind: MuteKind;
  id: string;
  /** epoch ms до которого действует mute; null = бессрочно. */
  untilMs: number | null;
};

/** Typed snooze presets для UI (1 час, 8 часов, 1 сутки, неделя). */
export const MUTE_SNOOZE_PRESETS_MS = {
  hour: 60 * 60 * 1000,
  eightHours: 8 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
} as const;

/** Логическое имя ключа (без префикса профиля — его ставит profileScopedKv). */
function keyFor(kind: MuteKind, id: string): string {
  // id — contact did:key / groupId / postId. Двоеточие в did:key не проблема
  // для нашего формата, т.к. parser ключа смотрит по первым двум префиксам
  // (`mute:<kind>:<...>`), оставшееся — сырой id.
  //
  // v4.32.510: обещание этого комментария наконец выполняется. Экраны глушили
  // переписку по открытому ключу в base64, а читатели уведомлений спрашивали
  // по did:key — два разных имени, совпасть не способных. Приведение стоит
  // здесь, чтобы девять вызывающих не решали этот вопрос каждый по-своему;
  // почему канонической выбрана именно форма did:key — см. muteChatId.
  return muteKey(kind, canonicalMuteId(kind, id));
}

// v4.32.502: разбор значения переехал в core/notifications/muteValue — его
// читает ещё и фоновый обработчик push, которому слой хранилища недоступен.
// Пока разбор жил здесь, у фонового пути своего разбора не было вовсе, и
// заглушённый собеседник будил телефон при закрытом приложении.

/**
 * Проверить, замьючен ли identifier.
 * Lazy-expire: если snooze истёк — удаляет ключ и возвращает false.
 */
export async function isMuted(kind: MuteKind, id: string): Promise<boolean> {
  if (!id) return false;
  const state = await getMuteState(kind, id);
  return state.muted;
}

export async function getMuteState(kind: MuteKind, id: string): Promise<{ muted: boolean; untilMs: number | null }> {
  if (!id) return { muted: false, untilMs: null };
  const now = Date.now();
  const parsed = parseMuteValue(await scopedKvGet(keyFor(kind, id)), now);
  if (muteExpired(parsed, now)) {
    // Отсрочка истекла (или запись порченая) — чистим и возвращаем unmuted.
    try { await scopedKvDelete(keyFor(kind, id)); } catch { /* noop */ }
    return { muted: false, untilMs: null };
  }
  return { muted: parsed.muted, untilMs: parsed.untilMs };
}

/**
 * Замьютить identifier.
 * @param opts.untilMs — epoch ms автопродления. Если не передан — бессрочно.
 */
export async function setMuted(
  kind: MuteKind,
  id: string,
  opts?: { untilMs?: number }
): Promise<void> {
  if (!id) return;
  const until = opts?.untilMs;
  let value = '1';
  if (until !== undefined) {
    const now = Date.now();
    // v4.32.490: срок проверяется на входе. Раньше хватало `typeof === number`,
    // а NaN — тоже number: он записывался как `until:NaN`, при чтении не
    // разбирался и давал «не заглушено» — то есть отсрочка молча не работала.
    // Прошедший срок — не отсрочка вовсе, и превращать его в бессрочное
    // молчание нельзя: это ровно то, чего человек не просил.
    if (!Number.isFinite(until) || until <= now) {
      log.warn('mute_set_bad_until', { kind, untilMs: until });
      await unmute(kind, id);
      return;
    }
    value = `until:${Math.round(Math.min(until, now + MUTE_MAX_MS))}`;
  }
  await scopedKvSet(keyFor(kind, id), value);
  log.info('mute_set', { kind, id: id.slice(0, 24), untilMs: until ?? null });
}

export async function unmute(kind: MuteKind, id: string): Promise<void> {
  if (!id) return;
  try { await scopedKvDelete(keyFor(kind, id)); } catch { /* noop */ }
  // v4.32.510: запись, сделанная прежней сборкой, лежит под неканоническим
  // именем. Снятие обязано забирать и её: иначе «включить уведомления» не
  // убирает человека из списка «Заглушённые», и убрать его оттуда становится
  // нечем вовсе.
  const raw = muteKey(kind, id);
  if (raw !== keyFor(kind, id)) {
    try { await scopedKvDelete(raw); } catch { /* noop */ }
  }
  log.info('mute_unset', { kind, id: id.slice(0, 24) });
}

/**
 * Список всех активных mute-записей.
 * @param kind — опционально фильтр. Без него — все kinds.
 *
 * Возвращает только НЕ истёкшие записи. Истёкшие автоматически чистит
 * (инвариант совместимости с isMuted/getMuteState).
 */
export async function listMuted(kind?: MuteKind): Promise<MuteEntry[]> {
  const keys = await scopedKvListKeysByPrefix(muteKeyPrefix(kind));
  const now = Date.now();
  const out: MuteEntry[] = [];
  for (const k of keys) {
    const parsedKey = parseMuteKey(k);
    if (!parsedKey) continue;
    const { kind: entryKind, id } = parsedKey;
    const parsed = parseMuteValue(await scopedKvGet(k), now);
    if (muteExpired(parsed, now)) {
      try { await scopedKvDelete(k); } catch { /* noop */ }
      continue;
    }
    if (!parsed.muted) continue;
    out.push({ kind: entryKind, id, untilMs: parsed.untilMs });
  }
  return out;
}

/**
 * Batch-cleanup истёкших mute-записей. Вызывается из App.tsx на foreground.
 * Без него истёкшие записи всё равно отсеиваются в isMuted/listMuted, но
 * sweep уменьшает размер kvStore и очищает UI-список «Заглушённые».
 */
export async function sweepExpiredMutes(): Promise<{ removed: number; migrated: number }> {
  const keys = await scopedKvListKeysByPrefix(muteKeyPrefix());
  const now = Date.now();
  let removed = 0;
  let migrated = 0;
  for (const k of keys) {
    const parsed = parseMuteValue(await scopedKvGet(k), now);
    if (muteExpired(parsed, now)) {
      try { await scopedKvDelete(k); removed++; } catch { /* noop */ }
      continue;
    }
    // v4.32.510: переезд записей, сделанных до появления канонического имени.
    // Без него заглушение, поставленное прежней сборкой, так и не начнёт
    // работать: колонка в базе показывает «без звука», а уведомления идут.
    // Уборка вызывается на каждом выходе приложения на передний план, то есть
    // первый же запуск после обновления всё чинит.
    const parsedKey = parseMuteKey(k);
    if (!parsedKey) continue;
    if (isCanonicalMuteId(parsedKey.kind, parsedKey.id)) continue;
    try {
      const target = keyFor(parsedKey.kind, parsedKey.id);
      // Свежая запись под правильным именем главнее: она сделана этой
      // сборкой и отражает последнее решение человека.
      if ((await scopedKvGet(target)) === null) {
        await scopedKvSet(target, parsed.untilMs === null ? '1' : `until:${parsed.untilMs}`);
      }
      await scopedKvDelete(k);
      migrated++;
    } catch { /* noop */ }
  }
  if (removed > 0 || migrated > 0) log.info('mute_sweep', { removed, migrated });
  return { removed, migrated };
}
