/**
 * Двухсторонний запрет копирования и пересылки: запись у себя, отправка
 * собеседнику, применение входящего решения (v4.32.571).
 *
 * Зачем понадобилось. До этой версии переключатель в карточке профиля закрывал
 * только СВОЙ экран, и в самой карточке об этом было написано честно, но от
 * этого настройка не переставала быть половиной обещания: включают её ради
 * того, чтобы собеседник не унёс переписку, а работала она везде, кроме его
 * телефона. Теперь решение уходит ему конвертом, и в переписке закрыты обе
 * стороны.
 *
 * Устройство — как у таймера исчезающих сообщений (disappearSync, v4.32.237):
 * разбор конверта отдельно и без зависимостей (copyGuardEnvelope), здесь —
 * доставка, запись и системная строка в чате. Отличие одно, и оно
 * принципиальное: у таймера значение общее, а тут решения ДВА и они не
 * смешиваются. Чужое решение ложится в свой ключ (copy_guard_peer:), и снять
 * его своей рукой нельзя — иначе достаточно было бы щёлкнуть переключателем
 * туда-обратно, чтобы открыть переписку, которую закрыл собеседник.
 *
 * Системная строка обязательна на обеих сторонах: у того, кому запрет пришёл,
 * молча исчезают «Копировать» и «Переслать», и без объяснения это выглядит
 * поломкой приложения, а не решением человека.
 *
 * Граница у обещания одна, и карточка профиля называет её словами: держится
 * запрет на ПРИЛОЖЕНИИ собеседника. Изменённый клиент волен его не послушать,
 * и снимок вторым телефоном не остановит ничто — от этого работает водяной
 * знак, а не переключатель.
 */
import { saveChatMessage } from '../storage/local';
import { profileManager } from '../identity/profileManager';
import { fanoutControlEnvelope, fanoutReasonText, type FanoutUndelivered } from './controlFanout';
import { log } from '../logger';
import { SYS_LINE_PREFIX } from './sysLineGuard';
import { setCopyGuard, setPeerCopyGuardFor } from './copyGuard';
import {
  COPY_GUARD_PREFIX,
  encodeCopyGuardEnvelope,
  decodeCopyGuardEnvelope,
  type CopyGuardEnvelope,
} from './copyGuardEnvelope';

export { COPY_GUARD_PREFIX, encodeCopyGuardEnvelope, decodeCopyGuardEnvelope };
export type { CopyGuardEnvelope };

/**
 * Тот же префикс системных строк, что у групп и таймера. Своей копии литерала
 * здесь быть не должно: именно этот префикс снимает stripSpoofedSysPrefix у
 * всего, что пришло по сети (v4.32.263).
 */
const SYS_PREFIX = SYS_LINE_PREFIX;

function sysText(on: boolean, byMe: boolean): string {
  const who = byMe ? 'Вы' : 'Собеседник';
  const verb = byMe ? (on ? 'включили' : 'сняли') : on ? 'включил' : 'снял';
  return `${SYS_PREFIX}${who} ${verb} запрет копирования и пересылки`;
}

/**
 * Системная строка с детерминированным id: повторная доставка того же
 * конверта не добавит вторую строку (INSERT OR IGNORE).
 */
async function insertSysRow(params: {
  peerPubB64: string;
  ownerProfileId: number;
  on: boolean;
  /** Время автора решения — от него считается id. */
  key: number;
  byMe: boolean;
}): Promise<void> {
  const { peerPubB64, ownerProfileId, on, key, byMe } = params;
  await saveChatMessage({
    id: `cg-${byMe ? 'me' : 'peer'}-${key}-${on ? '1' : '0'}`,
    contactPubB64: peerPubB64,
    cid: null,
    text: sysText(on, byMe),
    direction: byMe ? 'out' : 'in',
    status: 'read',
    mediaCids: null,
    // Место в ленте — по своему времени: по чужому ts строка легла бы куда
    // угодно, в том числе в будущее.
    createdAt: Date.now(),
    ownerProfileId,
  });
}

/** Итог включения запрета. */
export type CopyGuardSyncResult = { synced: true } | { synced: false; warning: string };

/**
 * Что сказать, когда решение до собеседника не доехало. Фраза называет и то,
 * что уже сделано у себя, и то, чего теперь не будет у него, — иначе человек
 * решит, что не сработало ничего, и щёлкнет обратно.
 */
function copyGuardWarning(on: boolean, reason: FanoutUndelivered): string {
  const head = on ? 'Запрет включён только у вас' : 'Запрет снят только у вас';
  const why = fanoutReasonText(reason, 'dm');
  const what = on
    ? 'У собеседника копирование и пересылка пока работают'
    : 'У собеседника они пока останутся выключенными';
  return `${head}: он об этом не узнал (${why}). ${what}`;
}

/** Записывает своё решение и сообщает его собеседнику. */
export async function setCopyGuardAndSync(params: {
  peerPubB64: string;
  on: boolean;
}): Promise<CopyGuardSyncResult> {
  const { peerPubB64, on } = params;
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  const ts = Date.now();
  await setCopyGuard(peerPubB64, on);
  await insertSysRow({ peerPubB64, ownerProfileId: pid, on, key: ts, byMe: true });

  const delivery = await fanoutControlEnvelope('copy_guard', encodeCopyGuardEnvelope({ on, ts }), {
    kind: 'dm',
    peerPubB64,
  });
  if (!delivery.sent) {
    return { synced: false, warning: copyGuardWarning(on, delivery.reason) };
  }
  return { synced: true };
}

/**
 * Применяет входящий конверт. true — конверт наш (даже если отброшен):
 * вызывающий не должен сохранять его как обычное сообщение.
 */
export async function handleIncomingCopyGuard(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<boolean> {
  if (!text.startsWith(COPY_GUARD_PREFIX)) return false;
  const env = decodeCopyGuardEnvelope(text);
  if (!env || !senderPubB64) return true;
  // Переписка определяется ПОДПИСАННЫМ отправителем: иначе любой контакт
  // запирал бы чужой разговор. Профиль-владелец приходит от службы переписки —
  // активным к этому моменту может быть уже другой (v4.32.481).
  await setPeerCopyGuardFor(ownerPid, senderPubB64, env.on);
  await insertSysRow({
    peerPubB64: senderPubB64,
    ownerProfileId: ownerPid,
    on: env.on,
    key: env.ts,
    byMe: false,
  });
  log.info('copy_guard_applied_remote', { from: senderPubB64.slice(0, 12), on: env.on });
  return true;
}
