/**
 * Разбор значения записи «без звука» — отдельно от хранилища (v4.32.502).
 *
 * Значение читают двое: muteStore, живущий поверх kv активного профиля, и
 * фоновый обработчик push, который поднимается на каждое входящее сообщение в
 * отдельном контексте и ходит в ту же таблицу напрямую — импортировать оттуда
 * слой хранилища нельзя, он потянет за собой миграции схемы, профили и
 * транспорт. Разбор при этом обязан совпадать до последней ветки: разойдись
 * они, и заглушённый собеседник продолжал бы будить телефон ровно тогда, когда
 * приложение закрыто, то есть когда тишина и нужна.
 *
 * Поэтому формат описан здесь один раз и без единого импорта.
 *
 * Формат значения:
 *   `"1"`               — бессрочно, до явного снятия;
 *   `"until:<epochMs>"` — отсрочка; по истечении запись снимается лениво.
 */

/**
 * Логическое имя ключа записи «без звука» (без префикса профиля).
 *
 * Живёт рядом с разбором значения, потому что читателей у записи двое, и
 * второй — фоновый обработчик push — собирает имя сам, без слоя хранилища.
 * Две руками написанные копии одного формата имени уже стоили нам чужих
 * заметок в соседнем профиле (v4.32.278).
 */
export type MuteKind = 'chat' | 'group' | 'channel' | 'post';

export const MUTE_KINDS: readonly MuteKind[] = ['chat', 'group', 'channel', 'post'];

const MUTE_KEY_PREFIX = 'mute:';

export function muteKey(kind: MuteKind, id: string): string {
  return `${MUTE_KEY_PREFIX}${kind}:${id}`;
}

/** Имя для prefix-scan: все записи разом или только одного вида. */
export function muteKeyPrefix(kind?: MuteKind): string {
  return kind ? `${MUTE_KEY_PREFIX}${kind}:` : MUTE_KEY_PREFIX;
}

/**
 * Обратный разбор имени. id — сырой (did:key содержит двоеточия), поэтому
 * делим по ПЕРВОМУ разделителю после вида, а не по всем.
 */
export function parseMuteKey(key: string): { kind: MuteKind; id: string } | null {
  if (!key.startsWith(MUTE_KEY_PREFIX)) return null;
  const rest = key.slice(MUTE_KEY_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const kind = rest.slice(0, sep) as MuteKind;
  const id = rest.slice(sep + 1);
  if (!id || !MUTE_KINDS.includes(kind)) return null;
  return { kind, id };
}

/**
 * Дольше года — это не отсрочка, а порченая запись: самый длинный пресет —
 * неделя. Такая запись снимается, а не подрезается: беззвучно потерять
 * сообщения хуже, чем получить лишнее уведомление.
 */
export const MUTE_MAX_MS = 365 * 24 * 60 * 60_000;

export type ParsedMute = { muted: boolean; untilMs: number | null; corrupt: boolean };

export function parseMuteValue(raw: string | null | undefined, now: number): ParsedMute {
  if (!raw) return { muted: false, untilMs: null, corrupt: false };
  if (raw === '1') return { muted: true, untilMs: null, corrupt: false };
  if (raw.startsWith('until:')) {
    const ms = parseInt(raw.slice('until:'.length), 10);
    if (!Number.isFinite(ms) || ms <= 0) return { muted: false, untilMs: null, corrupt: true };
    if (ms > now + MUTE_MAX_MS) return { muted: false, untilMs: null, corrupt: true };
    return { muted: true, untilMs: ms, corrupt: false };
  }
  // Формат, которого мы не писали: чужая запись под нашим именем или порча.
  return { muted: false, untilMs: null, corrupt: true };
}

/** Пора ли убрать запись: истекла или порченая. */
export function muteExpired(parsed: ParsedMute, now: number): boolean {
  return parsed.corrupt || (parsed.muted && parsed.untilMs !== null && parsed.untilMs <= now);
}

/** Действует ли запись прямо сейчас. Читателю без права на уборку — этого хватает. */
export function isMuteActive(raw: string | null | undefined, now: number): boolean {
  const parsed = parseMuteValue(raw, now);
  return parsed.muted && !muteExpired(parsed, now);
}
