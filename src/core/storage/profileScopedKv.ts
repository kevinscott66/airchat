/**
 * Чтение и запись kv в namespace активного профиля (v4.32.325).
 *
 * Правило «своё у каждого аккаунта, а запись без префикса принадлежит первому»
 * уже написано в privacyPrefs — и написано верно. Проблема в том, что оно там
 * одно на четыре переключателя, а ключей с тем же требованием больше: карты
 * «кому какая версия профиля отправлена» и «кому сообщено решение о времени
 * последнего входа» — это списки открытых ключей собеседников, то есть граф
 * связей. Лежали они под общими именами, поэтому:
 *
 * - переживали удаление профиля (уборка сметает `p<id>:%`, а общие имена под
 *   это правило не попадают) и доставались следующему аккаунту с тем же
 *   номером;
 * - смешивали адресатов разных аккаунтов в одной записи.
 *
 * Поэтому правило вынесено сюда, а не переписано ещё раз: разъехавшиеся копии
 * одного правила про имена ключей уже стоили нам чужих заметок в соседнем
 * профиле (v4.32.278) и потерянных контактов при восстановлении (v4.32.280).
 */
import { kvDelete, kvListKeysByPrefix, kvSet, kvTryGet } from './local';
import { profileScopedKey } from './kvKeys';
import { profileManager } from '../identity/profileManager';

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

/**
 * Значение ключа для активного профиля.
 *
 * Запись без префикса делалась тогда, когда профиль был один: она принадлежит
 * первому и наследуется только им — и сразу забирается в его namespace, иначе
 * оставленная лежать общая запись снова досталась бы всем. Остальным профилям
 * возвращается null, то есть «ничего ещё не было».
 */
export async function scopedKvGet(key: string): Promise<string | null> {
  return scopedKvGetFor(activeProfileId(), key);
}

/**
 * То же самое, но для названного профиля (v4.32.460).
 *
 * «Активный» — это про экран, а не про работу. Фоновые службы живут по одной на
 * пару ключей и переживают переключение профиля: приём личного сообщения ждёт
 * сеть секундами, и к моменту чтения настройки активным может быть уже другой
 * аккаунт. Тогда к чужому разговору применялись бы чужие решения. Кто знает
 * свой номер — называет его, а не спрашивает у экрана.
 */
export async function scopedKvGetFor(pid: number, key: string): Promise<string | null> {
  return (await scopedKvTryGetFor(pid, key))?.value ?? null;
}

/**
 * То же чтение, но провал отличим от «ничего не записано» (v4.32.474).
 *
 * Нужно тем, кто по значению принимает решение о приватности: «переключатель
 * не трогали» и «база не ответила» требуют разных ответов, а null отвечает на
 * оба сразу. Возвращает `{ value }` при успехе и `null`, если прочитать не
 * удалось.
 */
export async function scopedKvTryGetFor(
  pid: number,
  key: string,
): Promise<{ value: string | null } | null> {
  const own = await kvTryGet(profileScopedKey(pid, key));
  if (own === null) return null;
  if (own.value != null) return own;
  if (pid !== 1) return { value: null };
  const legacy = await kvTryGet(key);
  if (legacy === null) return null;
  if (legacy.value == null) return { value: null };
  // Сначала копия, потом удаление: падение между ними стоит записи.
  await kvSet(profileScopedKey(pid, key), legacy.value);
  await kvDelete(key);
  return legacy;
}

/** Записать значение активному профилю. */
export async function scopedKvSet(key: string, value: string): Promise<void> {
  await scopedKvSetFor(activeProfileId(), key, value);
}

/**
 * Записать значение НАЗВАННОМУ профилю (v4.32.479).
 *
 * Симметрично scopedKvGetFor, и по той же причине — но у записи цена ошибки
 * выше. Служба, которая прочитала своё, ушла в сеть на секунды и вернулась
 * записывать, спрашивала «кто сейчас активен» второй раз: между чтением и
 * записью человек успевает переключить аккаунт, и итог работы одного профиля
 * ложится в namespace другого. Это не только потеря своей записи — это ещё и
 * подмена чужой.
 */
export async function scopedKvSetFor(pid: number, key: string, value: string): Promise<void> {
  await kvSet(profileScopedKey(pid, key), value);
  if (pid === 1) {
    // Общая запись первого профиля больше не нужна: своя новее, а оставленная
    // лежать она перебила бы её при чтении по старому имени.
    await kvDelete(key);
  }
}

/** Удалить запись активного профиля — вместе с общей, если профиль первый. */
export async function scopedKvDelete(key: string): Promise<void> {
  await scopedKvDeleteFor(activeProfileId(), key);
}

/**
 * То же удаление, но для названного профиля (v4.32.571).
 *
 * Нужно по той же причине, что и `scopedKvGetFor`: снять запись просит и
 * фоновый приём сообщений, у которого свой номер профиля — тот, чьим ключом
 * расшифрован конверт. Спрашивать номер у экрана он не может: пока конверт
 * шёл, активным мог стать другой аккаунт, и стёрлась бы чужая запись.
 */
export async function scopedKvDeleteFor(pid: number, key: string): Promise<void> {
  await kvDelete(profileScopedKey(pid, key));
  if (pid === 1) await kvDelete(key);
}

/**
 * Логические имена ключей активного профиля, начинающиеся с `prefix` (v4.32.490).
 *
 * Нужен тем, у кого ключей не пара, а список: заглушённые чаты, например,
 * перечисляются сканом по префиксу, и без этой функции они либо остались бы
 * общими, либо каждый вызывающий писал бы разбор префикса заново.
 *
 * Записи без префикса принадлежат первому профилю и здесь же забираются в его
 * namespace — по тому же правилу, что и одиночное чтение. Остальные профили
 * их не видят: скан по `p<id>:<prefix>` до общих имён не достаёт.
 */
export async function scopedKvListKeysByPrefix(prefix: string): Promise<string[]> {
  const pid = activeProfileId();
  const cut = profileScopedKey(pid, '').length;
  const keys = new Set(
    (await kvListKeysByPrefix(profileScopedKey(pid, prefix))).map((k) => k.slice(cut)),
  );
  if (pid !== 1) return [...keys];
  for (const legacy of await kvListKeysByPrefix(prefix)) {
    const own = await kvTryGet(profileScopedKey(1, legacy));
    // База не ответила — общую запись не трогаем: удалить, не скопировав,
    // значит потерять её насовсем.
    if (own === null) continue;
    let has = own.value != null;
    if (!has) {
      const bare = await kvTryGet(legacy);
      if (bare === null) continue;
      if (bare.value != null) {
        await kvSet(profileScopedKey(1, legacy), bare.value);
        has = true;
      }
    }
    await kvDelete(legacy);
    if (has) keys.add(legacy);
  }
  return [...keys];
}
