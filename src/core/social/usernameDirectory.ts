/**
 * Куда ведёт `@имя` (v4.32.607).
 *
 * До этой версии нажатие на упоминание искало человека только в адресной
 * книге, и любой промах объявлялся одинаково: «@name нет в ваших контактах».
 * Обе половины этой фразы были неправдой. Во-первых, имени могло не
 * существовать вовсе — тогда речь не про контакты, а про опечатку. Во-вторых,
 * контакт для перехода не нужен: имя и заведено затем, чтобы прийти к тому,
 * кого ещё не знаешь.
 *
 * Поэтому разрешение идёт в два шага. Сначала контакты: у знакомого есть
 * подпись, которую человек дал ему сам, и её незачем терять. Если в контактах
 * промах — спрашиваем общий реестр имён, и он различает три разных ответа:
 * имя свободно, имя занято но владелец не опубликовал ключ (запись старше
 * v4.32.607), имя занято и ключ есть. Плюс четвёртый исход — «спросить не
 * удалось»: сервер не настроен или недоступен, и говорить в этом случае «не
 * существует» нельзя.
 *
 * Имена, не проходящие `normalizeUsername`, в реестр не идут: там их быть не
 * может, а лишний сетевой запрос выдал бы серверу то, что человек написал.
 */
import { normalizeUsername } from '../identity/username';
import { lookupSyncUsername } from '../sync/syncApi';
import { lookupMention } from './mentionLookup';

export type MentionTarget =
  /** Свой контакт: адрес и подпись берутся с устройства. */
  | { status: 'contact'; peerPubB64: string; displayName: string }
  /**
   * Незнакомый владелец имени из общего реестра.
   *
   * v4.32.616: имени здесь нет намеренно — реестр его не хранит. Раньше в
   * `displayName` уезжал сам юзернейм, и карточка выдавала его за имя: человек,
   * назвавшийся у себя «Ритой», открывался как «margarita». Юзернейм — адрес,
   * а не имя, и показывать его надо там, где показывают адрес. Настоящее имя
   * приезжает конвертом профиля при первой же переписке.
   *
   * v4.32.722: а до переписки — из реестра: владелец публикует там имя,
   * которым назвался (`peerName`). `null` — не опубликовал; тогда карточка
   * честно «Без имени», но юзернейм в имя по-прежнему не идёт.
   */
  | { status: 'stranger'; peerPubB64: string; username: string; peerName: string | null }
  /** Имя носят несколько контактов — открывать наугад нельзя. */
  | { status: 'ambiguous' }
  /** Такого имени нет ни у кого. */
  | { status: 'unclaimed' }
  /** Имя занято, но владелец не назвал ключ: перейти некуда. */
  | { status: 'unlisted' }
  /**
   * Реестра в этой сборке нет: адрес сервера не задан. Отдельно от `unknown`,
   * потому что «нет связи» здесь неправда — сеть в порядке, спрашивать некого,
   * и повтор не поможет.
   */
  | { status: 'unconfigured' }
  /** Проверить не вышло: реестр не ответил. */
  | { status: 'unknown' };

export async function resolveMentionTarget(raw: string, ownerProfileId: number): Promise<MentionTarget> {
  const local = await lookupMention(raw, ownerProfileId);
  if (local.status === 'found') {
    return { status: 'contact', peerPubB64: local.peerPubB64, displayName: local.displayName };
  }
  if (local.status === 'ambiguous') return { status: 'ambiguous' };

  const username = normalizeUsername(raw);
  if (!username) return { status: 'unclaimed' };

  const answer = await lookupSyncUsername(username);
  if (answer.status === 'unconfigured') return { status: 'unconfigured' };
  if (answer.status === 'unknown') return { status: 'unknown' };
  if (answer.status === 'free') return { status: 'unclaimed' };
  if (!answer.peerPubB64) return { status: 'unlisted' };
  return { status: 'stranger', peerPubB64: answer.peerPubB64, username, peerName: answer.peerName };
}

/** Что показать человеку, когда переходить некуда. */
export function mentionMissText(
  status: 'ambiguous' | 'unclaimed' | 'unlisted' | 'unconfigured' | 'unknown',
  name: string,
): string {
  switch (status) {
    case 'ambiguous':
      return `Имя «${name}» носят несколько контактов — откройте нужного в списке`;
    case 'unclaimed':
      return `Юзернейма @${name} не существует`;
    case 'unlisted':
      return `@${name} занят, но владелец не открыл переход по имени`;
    case 'unconfigured':
      return `Не найти @${name}: поиск по имени в этой сборке не настроен`;
    default:
      return `Не удалось проверить @${name} — нет связи с сервером`;
  }
}
