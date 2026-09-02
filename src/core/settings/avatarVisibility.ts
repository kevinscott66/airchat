/**
 * Кто видит фотографию профиля (v4.32.540).
 *
 * До этой версии фотография была единственным полем карточки без собственного
 * решения: имя и «о себе» человек мог не заполнять, а фотография, однажды
 * поставленная, уезжала всем, с кем шла переписка, и отозвать её было нельзя
 * — только удалить у себя. Между тем прячут её не вместе со всем остальным:
 * «пусть видят имя, но не лицо» — обычная просьба, и до сих пор ответить на
 * неё было нечем.
 *
 * Три положения, и все три — про рассылку карточки, а не про показ на своём
 * экране: своё фото владелец видит всегда.
 *
 *   everybody — всем, с кем идёт переписка. Так было до этой версии, поэтому
 *               это и значение по умолчанию: молча прятать фотографию у тех,
 *               кто её уже поставил, значило бы менять их решение за них.
 *   contacts  — только тем, кто есть в списке контактов.
 *   nobody    — фотография не покидает устройство.
 *
 * Правило хранится рядом с остальными решениями о приватности и, как они, —
 * в namespace профиля: второй аккаунт заводят как раз затем, чтобы его не
 * связали с первым, и общая настройка это отменяла бы (см. privacyPrefs).
 */
import { privacyPrefGetFor, privacyPrefSet } from './privacyPrefs';

export type AvatarVisibility = 'everybody' | 'contacts' | 'nobody';

const KEY = 'privacy_avatar_visibility' as const;

/** Приводит запись к одному из трёх положений. Неизвестное — как умолчание. */
export function parseAvatarVisibility(value: unknown): AvatarVisibility {
  return value === 'contacts' || value === 'nobody' ? value : 'everybody';
}

/** Решение названного профиля. */
export async function avatarVisibilityFor(pid: number): Promise<AvatarVisibility> {
  return parseAvatarVisibility(await privacyPrefGetFor(pid, KEY));
}

/** Записать решение активного профиля. */
export async function setAvatarVisibility(value: AvatarVisibility): Promise<void> {
  await privacyPrefSet(KEY, value);
}
