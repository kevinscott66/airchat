/**
 * Решения о приватности — по одному набору на аккаунт (v4.32.311).
 *
 * Четыре переключателя: кто видит, когда я был в сети; кто может мне писать;
 * кто может добавлять меня в группы; отправлять ли отметки о прочтении. Все
 * четыре лежали в kv под общими именами — одни на устройство.
 *
 * Профили в этом приложении заводят затем, чтобы разделить, кем человек
 * представляется: у каждого свои ключи, своё имя, свои контакты, своя лента.
 * Общая настройка это разделение молча отменяла. Второй аккаунт, заведённый
 * ровно для того, чтобы его не связали с первым, наследовал «когда я в сети —
 * видно всем» и начинал рассказывать о своей активности всем подряд; человек
 * при этом видел в настройках именно то положение переключателя, которое сам
 * когда-то выбрал, — только выбирал он его для другого аккаунта.
 *
 * Читают эти ключи фоновые службы (присутствие, приём личных сообщений, заявки
 * в группы), поэтому доступ здесь, а не в экране настроек: правило чтения и
 * правило записи должны быть одним куском кода. Разъехавшиеся копии одного
 * правила про имена ключей уже стоили чужих заметок в соседнем профиле
 * (v4.32.278) и потерянных контактов при восстановлении (v4.32.280).
 */
import { kvDelete, kvGet, kvSet } from '../storage/local';
import { notifyOnlineKey, profileScopedKey, type PrivacyPrefKey } from '../storage/kvKeys';
import { scopedKvGet, scopedKvGetFor, scopedKvTryGetFor, scopedKvSet } from '../storage/profileScopedKv';
import { profileManager } from '../identity/profileManager';
import { log } from '../logger';

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

/**
 * Значение переключателя для активного профиля.
 *
 * Запись без префикса делалась тогда, когда профиль был один, — она
 * принадлежит первому и наследуется только им. Остальным возвращается null,
 * то есть значение по умолчанию: иначе разделение профилей осталось бы
 * украшением. Так же читаются контакты, блок-лист и карточка профиля.
 */
export async function privacyPrefGet(key: PrivacyPrefKey): Promise<string | null> {
  // v4.32.325: само правило — в storage/profileScopedKv, рядом с именами
  // ключей. Здесь остаются только переключатели приватности.
  return scopedKvGet(key);
}

/**
 * Значение переключателя для названного профиля (v4.32.460).
 *
 * Для тех, кто знает, чей он: приём личного сообщения идёт под своей парой
 * ключей и ждёт сеть секундами — активным к этому времени может стать другой
 * аккаунт, и к разговору применились бы его решения.
 */
export async function privacyPrefGetFor(pid: number, key: PrivacyPrefKey): Promise<string | null> {
  return scopedKvGetFor(pid, key);
}

/** Записать переключатель активному профилю. */
export async function privacyPrefSet(key: PrivacyPrefKey, value: string): Promise<void> {
  await scopedKvSet(key, value);
  log.debug('privacy_pref_set', { key });
}

/** `true`/`false` из kv, где значения хранятся строкой. */
export async function privacyPrefBool(key: PrivacyPrefKey): Promise<boolean> {
  return (await privacyPrefGet(key)) === 'true';
}

/** То же для названного профиля. */
export async function privacyPrefBoolFor(pid: number, key: PrivacyPrefKey): Promise<boolean> {
  return (await privacyPrefGetFor(pid, key)) === 'true';
}

/**
 * Значение-строка, где «не смогли прочитать» отличимо от «не трогали»
 * (v4.32.475). Для переключателей с тремя положениями — «кто видит, когда я
 * был в сети»: там ответ не да/нет, а одно из трёх.
 */
export async function privacyPrefTryGet(
  key: PrivacyPrefKey,
): Promise<{ value: string | null } | null> {
  return await privacyPrefTryGetFor(activeProfileId(), key);
}

/** То же для названного профиля (v4.32.479) — см. privacyPrefGetFor. */
export async function privacyPrefTryGetFor(
  pid: number,
  key: PrivacyPrefKey,
): Promise<{ value: string | null } | null> {
  const read = await scopedKvTryGetFor(pid, key);
  if (read === null) log.warn('privacy_pref_unreadable', { key, pid });
  return read;
}

/**
 * Значение переключателя, где «не смогли прочитать» отличимо от «не трогали»
 * (v4.32.474).
 *
 * До этого места ошибка чтения базы приходила сюда как null — тем же ответом,
 * что и нетронутый переключатель, — и решение всякий раз выпадало в сторону
 * «разрешено». Ветки «не смогли прочитать», написанные у вызывающих, при этом
 * выглядели рабочими: они ловили исключение, которого не бывает.
 *
 * `null` — прочитать не удалось; решение принимает вызывающий, потому что
 * осторожная сторона у каждого переключателя своя.
 */
export async function privacyPrefTryBoolFor(
  pid: number,
  key: PrivacyPrefKey,
): Promise<boolean | null> {
  const read = await scopedKvTryGetFor(pid, key);
  if (read === null) {
    log.warn('privacy_pref_unreadable', { key, pid });
    return null;
  }
  return read.value === 'true';
}

/**
 * Отправлять ли отметку о прочтении — общий ответ для личных переписок и групп
 * (v4.32.312).
 *
 * Правило одно, потому что переключатель в настройках один. Прежде его
 * спрашивал только экран переписки, да ещё и по копии значения, прочитанной при
 * открытии чата; групповые отметки не спрашивали вовсе и продолжали уходить,
 * складываясь в `seen_by` — список «кто видел» с временем, видимый остальным
 * участникам.
 *
 * Не смогли прочитать — считаем, что отправлять нельзя: неотправленную отметку
 * можно послать позже, отправленную не отозвать.
 */
export async function readReceiptsAllowed(): Promise<boolean> {
  return readReceiptsAllowedFor(activeProfileId());
}

/** То же для названного профиля (v4.32.460). */
export async function readReceiptsAllowedFor(pid: number): Promise<boolean> {
  try {
    // v4.32.474: правило «не смогли прочитать — не отправляем» записано выше с
    // v4.32.312, но не исполнялось: чтение гасило ошибку базы и отвечало
    // «переключатель не трогали», то есть отметки уходили именно тогда, когда
    // про запрет узнать было неоткуда.
    const disabled = await privacyPrefTryBoolFor(pid, 'privacy_disable_read_receipts');
    if (disabled === null) return false;
    return !disabled;
  } catch (e) {
    log.warn('read_receipt_pref_unreadable', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * «Сообщить, когда этот человек появится» — одноразовая просьба (v4.32.311).
 *
 * Тоже была общей на устройство, и это заметно неприятнее переключателей:
 * контакты у профилей разные, и второй аккаунт получал уведомление про
 * человека, которого сам не добавлял и, возможно, не знает вовсе, — то есть
 * связь между двумя аккаунтами всплывала прямо на экране блокировки.
 */
export async function notifyOnlineGet(peerPubB64: string): Promise<boolean> {
  const pid = activeProfileId();
  const key = notifyOnlineKey(peerPubB64);
  const own = await kvGet(profileScopedKey(pid, key));
  if (own != null) return own === '1';
  if (pid !== 1) return false;
  return (await kvGet(key)) === '1';
}

export async function notifyOnlineSet(peerPubB64: string, on: boolean): Promise<void> {
  const pid = activeProfileId();
  const key = notifyOnlineKey(peerPubB64);
  await kvSet(profileScopedKey(pid, key), on ? '1' : '0');
  if (pid === 1) await kvDelete(key);
}
