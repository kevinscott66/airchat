/**
 * «Пароль сменился — конверт на сервере остался под старым».
 *
 * v4.32.868. Правило само по себе не новое: третье состояние подсказки
 * (`stale`) завели в v4.32.615 ровно затем, чтобы человек узнал о запертой
 * копии сегодня, а не в единственный день, когда слов на руках уже нет.
 * Новое здесь — место. Пометку ставил экран настроек, у себя внутри, и путь
 * «забыл пароль → восстановил по 24 словам → задал новый» проходил мимо: тот
 * же самый конверт оставался под прежним паролем, а настройки продолжали
 * обещать запасной путь. Заметить это можно было только на новом телефоне.
 *
 * Поэтому чтение, решение и запись переехали сюда — к правилу, которое их
 * описывает, — и оба пути смены пароля зовут одно и то же.
 *
 * Модуль говорит исходом, а не исключением: к моменту вызова пароль уже
 * сменён, и ронять сделанную работу на подсказке нельзя. А соврать про неё —
 * нельзя тем более, поэтому «не легло» и «не прочиталось» названы отдельно:
 * экран из них строит разный текст.
 */
import { log } from '../logger';
import type { StaleMark } from './staleMark';
import {
  APPLE_BINDING_STORED,
  hintAfterPasswordChange,
  parseAppleBindingHint,
} from './appleBindingHint';
import { scopedKvGet, scopedKvSetChecked } from '../storage/profileScopedKv';

/**
 * Ключ подсказки «здесь уже привязывали слова к Apple ID».
 *
 * Подсказка для надписи на кнопке, не источник истины: запись живёт на
 * сервере под слепым индексом, и увидеть её можно только предъявив токен
 * Apple. Флажок у профиля свой — привязка тоже своя у каждого аккаунта,
 * оттого и namespace профиля.
 */
export const APPLE_BINDING_HINT_KEY = 'apple_seed_binding_v1';

/**
 * Что вышло из попытки пометить привязку устаревшей.
 *
 * v4.32.869: слово общее с копией в облаке — исход у обеих один и тот же, см.
 * `staleMark`. Имя оставлено прежним: оно уже названо в вызовах.
 */
export type AppleBindingStaleOutcome = StaleMark;

/**
 * Пометить привязку к Apple ID устаревшей после смены пароля приложения.
 *
 * Перешифровать конверт молча нечем: `putSeedBinding` требует свежий вход
 * через Apple, то есть системное окно. Поэтому честная пометка и просьба
 * привязать заново — всё, что здесь возможно.
 */
export async function markAppleBindingStale(): Promise<AppleBindingStaleOutcome> {
  let next: ReturnType<typeof hintAfterPasswordChange>;
  try {
    next = hintAfterPasswordChange(parseAppleBindingHint(await scopedKvGet(APPLE_BINDING_HINT_KEY)));
  } catch (e) {
    log.warn('apple_binding_hint_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return 'unknown';
  }
  if (!next) return 'not_bound';
  try {
    const ok = await scopedKvSetChecked(APPLE_BINDING_HINT_KEY, APPLE_BINDING_STORED[next]);
    return ok ? 'marked' : 'unwritten';
  } catch (e) {
    log.warn('apple_binding_hint_write_failed', { err: e instanceof Error ? e.message : String(e) });
    return 'unwritten';
  }
}

/** Что сказать человеку про запертую копию. Текст один на оба экрана. */
export const APPLE_BINDING_STALE_TEXT = {
  marked: 'Привязка к Apple ID больше не откроется новым паролем — привяжите слова заново.',
  unwritten:
    'Привязка к Apple ID больше не откроется новым паролем, а пометить её не удалось: после перезапуска настройки снова покажут «привязаны». Привяжите слова заново сейчас.',
} as const;
