/**
 * copyGuard — «Запрет копирования и пересылки» для отдельной переписки
 * (v4.32.568; пересылка — v4.32.569, снимок экрана — v4.32.570,
 * двухсторонний — v4.32.571).
 *
 * Что это НЕ такое, и почему это написано первой строкой. Это не DRM и не
 * защита от чужого второго телефона: человек, который решил вынести переписку
 * намеренно, снимет экран другим устройством, и от этого работает водяной
 * знак, а не этот переключатель.
 *
 * Что это такое: выключенные пути «вынести сообщение из этой переписки»
 * внутри приложения — «Копировать» и «Переслать» в меню сообщения (и на iOS,
 * и в нижнем меню Android), обе эти кнопки в панели выделения, копирование
 * перевода и выгрузка переписки. «Скопировать ссылку на сообщение» остаётся:
 * ссылка — это адрес, а не текст, и без доступа к переписке она никому ничего
 * не покажет.
 *
 * Со снимком экрана на своём устройстве помогает airchat-screen-guard: на iOS
 * лента уезжает под защищённый слой (видна глазу, не попадает в снимок и
 * запись), на Android закрывается всё окно, пока переписка открыта.
 *
 * ДВЕ СТОРОНЫ (v4.32.571). Раньше флаг жил только у того, кто его включил, —
 * то есть настройка, которую включают РАДИ собеседника, работала везде, кроме
 * его телефона. Теперь решение уходит ему конвертом (copyGuardSync), и в
 * переписке закрыты обе стороны. Отсюда два ключа, а не один:
 *
 *   copy_guard:<pub>      — запрет включил я;
 *   copy_guard_peer:<pub> — запрет включил собеседник.
 *
 * Разделены они потому, что снять чужое решение своей рукой нельзя: выключив
 * свой запрет, я не должен открывать переписку, которую закрыл собеседник, —
 * иначе достаточно было бы щёлкнуть переключателем туда-обратно. Переписка
 * закрыта, пока горит хотя бы один ключ.
 *
 * Честная граница у этого ровно одна, и она названа в карточке профиля:
 * держится запрет на ПРИЛОЖЕНИИ собеседника. Изменённый клиент волен его не
 * послушать — как и в любом мессенджере, где такая настройка есть.
 *
 * Ключи живут в профильном kv, а не в столбце таблицы `conversations`: у
 * контакта, с которым переписки ещё не было, строки в этой таблице нет, а
 * запретить копирование в его карточке человек может.
 */

import {
  scopedKvDelete,
  scopedKvDeleteCheckedFor,
  scopedKvSetCheckedFor,
  scopedKvTryGetFor,
} from '../storage/profileScopedKv';
import { profileManager } from '../identity/profileManager';
import { log } from '../logger';

const PREFIX = 'copy_guard:';
const PEER_PREFIX = 'copy_guard_peer:';

/** Ключ своего решения. Публичный ключ — уже base64 и в ключе безопасен. */
export function copyGuardKey(peerPubB64: string): string {
  return `${PREFIX}${peerPubB64}`;
}

/** Ключ решения собеседника. */
export function peerCopyGuardKey(peerPubB64: string): string {
  return `${PEER_PREFIX}${peerPubB64}`;
}

/** Чьими решениями закрыта переписка. */
export type CopyGuardState = {
  /** Запрет включил я. */
  mine: boolean;
  /** Запрет включил собеседник. */
  theirs: boolean;
};

/** Закрыта ли переписка. Хватает одного решения из двух. */
export function copyGuardOn(state: CopyGuardState): boolean {
  return state.mine || state.theirs;
}

/**
 * Слушатели держат экран диалога в согласии с карточкой профиля: переключить
 * запрет можно из карточки, открытой поверх этого же диалога, а ещё запрет
 * может прийти от собеседника прямо во время разговора.
 */
const listeners = new Set<(peerPubB64: string, on: boolean) => void>();

export function subscribeCopyGuard(cb: (peerPubB64: string, on: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

/**
 * Сообщает экранам новое состояние — но только если оно про тот аккаунт,
 * который сейчас открыт. Конверт от собеседника применяется к владельцу пары
 * ключей, которой он расшифрован, и к моменту разбора активным может быть уже
 * другой профиль: без этой проверки чужое решение перекрасило бы открытый
 * чужой диалог.
 */
function notify(pid: number, peerPubB64: string, on: boolean): void {
  if (pid !== activeProfileId()) return;
  for (const cb of listeners) {
    try {
      cb(peerPubB64, on);
    } catch {
      /* один слушатель не должен ронять остальных */
    }
  }
}

/**
 * Оба решения по переписке для названного профиля, где сбой чтения отличим от
 * «запрета нет» (v4.32.655).
 *
 * До этого здесь стоял try/catch, а читал он через scopedKvGetFor — тот сам
 * гасит отказ базы и отдаёт null, то есть «не прочиталось» приходило сюда под
 * видом «ключа нет», catch не срабатывал ни разу, и строка copy_guard_read_failed
 * не появилась в журнале ни разу за всё время. Запрет при этом тихо снимался:
 * копирование, пересылка, выгрузка и снимок экрана снова работали в переписке,
 * которую человек закрыл. Читаем формой, которая различает три состояния.
 */
export async function copyGuardStateTryFor(
  pid: number,
  peerPubB64: string
): Promise<CopyGuardState | null> {
  const [mine, theirs] = await Promise.all([
    scopedKvTryGetFor(pid, copyGuardKey(peerPubB64)),
    scopedKvTryGetFor(pid, peerCopyGuardKey(peerPubB64)),
  ]);
  if (mine === null || theirs === null) {
    log.warn('copy_guard_read_failed', { pid });
    return null;
  }
  return { mine: mine.value === '1', theirs: theirs.value === '1' };
}

/**
 * Оба решения по переписке для названного профиля.
 *
 * Непрочитанное решение показывается выключенным: переключатель, значение
 * которого мы не знаем, не должен рисоваться включённым — человек решит, что
 * запрет включился сам. Это ответ ДЛЯ ЭКРАНА. Запирать переписку по нему
 * нельзя: для этого есть isCopyGuarded, и он читает сам.
 */
export async function copyGuardStateFor(pid: number, peerPubB64: string): Promise<CopyGuardState> {
  return (await copyGuardStateTryFor(pid, peerPubB64)) ?? { mine: false, theirs: false };
}

/**
 * Закрыта ли переписка сейчас; непрочитанное состояние считается закрытым.
 *
 * Две ошибки здесь стоят по-разному. Лишний запрет виден человеку и живёт до
 * следующего успешного чтения — он его переключит. Лишнее разрешение не видно
 * никому и уже необратимо: сообщение переслано, снимок сделан.
 */
async function guardedNow(pid: number, peerPubB64: string): Promise<boolean> {
  const state = await copyGuardStateTryFor(pid, peerPubB64);
  return state === null ? true : copyGuardOn(state);
}

/** Оба решения по переписке для активного профиля. */
export async function copyGuardState(peerPubB64: string): Promise<CopyGuardState> {
  return copyGuardStateFor(activeProfileId(), peerPubB64);
}

/**
 * Закрыта ли переписка — чьим бы решением она ни была закрыта.
 *
 * В отличие от copyGuardState, отвечающего экрану, этот ответ запирает: см.
 * guardedNow про цену двух ошибок.
 */
export async function isCopyGuarded(peerPubB64: string): Promise<boolean> {
  return guardedNow(activeProfileId(), peerPubB64);
}

/**
 * Кладёт или снимает один ключ запрета и говорит, легло ли (v4.32.655).
 *
 * Выключение стирает ключ, а не пишет '0': ключей ровно столько, сколько
 * переписок с включённым запретом.
 *
 * Обе половины берут проверенные формы. Раньше стояли scopedKvSetFor и
 * scopedKvDeleteFor — обе отдают void и гасят отказ базы внутри, так что
 * «не влезло на диск» приходило к вызывающему тем же самым, что и «легло»:
 * карточка профиля рисовала переключатель в положении, которого в базе нет, а
 * собеседнику уходил конверт про запрет, которого у нас не записано.
 */
async function writeGuardKey(pid: number, key: string, on: boolean): Promise<boolean> {
  if (on) {
    const written = await scopedKvSetCheckedFor(pid, key, '1');
    if (!written) log.warn('copy_guard_write_failed', { pid, on });
    return written;
  }
  try {
    // Снятие отчитывается броском, а не значением — см. scopedKvDeleteCheckedFor.
    await scopedKvDeleteCheckedFor(pid, key);
    return true;
  } catch (e) {
    log.warn('copy_guard_write_failed', {
      pid,
      on,
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Записывает СВОЁ решение. Собеседнику оно отсюда не уходит — это делает
 * `setCopyGuardAndSync`, потому что доставка умеет не удаться, и человеку об
 * этом говорят словами.
 */
export async function setCopyGuard(peerPubB64: string, on: boolean): Promise<boolean> {
  const pid = activeProfileId();
  if (!(await writeGuardKey(pid, copyGuardKey(peerPubB64), on))) return false;
  // Экранам говорят только про запись, которая действительно легла.
  notify(pid, peerPubB64, on || (await guardedNow(pid, peerPubB64)));
  return true;
}

/**
 * Записывает решение СОБЕСЕДНИКА для названного профиля (v4.32.571).
 *
 * Номер профиля называет вызывающий: решение относится к тому аккаунту, чьим
 * ключом расшифрован конверт, а не к тому, что открыт на экране.
 */
export async function setPeerCopyGuardFor(
  pid: number,
  peerPubB64: string,
  on: boolean
): Promise<boolean> {
  if (!(await writeGuardKey(pid, peerCopyGuardKey(peerPubB64), on))) return false;
  notify(pid, peerPubB64, on || (await guardedNow(pid, peerPubB64)));
  return true;
}

/** Обе записи по переписке — для уборки при удалении контакта и профиля. */
export async function clearCopyGuard(peerPubB64: string): Promise<void> {
  await scopedKvDelete(copyGuardKey(peerPubB64));
  await scopedKvDelete(peerCopyGuardKey(peerPubB64));
  notify(activeProfileId(), peerPubB64, false);
}
