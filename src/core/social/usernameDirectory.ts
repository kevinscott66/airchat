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
import { checkUsernameKeyPin } from './usernameKeyPin';

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
  | {
      status: 'stranger';
      peerPubB64: string;
      username: string;
      peerName: string | null;
      /**
       * v4.32.945: за этим именем раньше стоял ДРУГОЙ ключ — `since` говорит,
       * с каких пор мы помним прежний. `null` — сошлось, встретили впервые или
       * свериться не вышло; отличать эти три случая вызывающему незачем, а вот
       * промолчать о четвёртом нельзя: переход по имени целиком верит серверу
       * справочника, и смена ключа — единственное, чем подмена себя выдаёт.
       * Подробности и границы — в usernameKeyPin.
       */
      keyChangedSince: number | null;
    }
  /**
   * За именем стоит группа или канал (v4.32.937).
   *
   * Пространство имён общее, и это его видимая сторона: одно и то же `@имя`
   * может принадлежать человеку ИЛИ каналу, но не обоим сразу. Открывать
   * карточку человека по такому имени нельзя — за ним человека нет; опознаётся
   * группа публичным идентификатором, как и везде.
   */
  | { status: 'space'; kind: 'group' | 'channel'; publicId: string; username: string }
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
  // Предмет проверяется ДО ключа: у группы своего ключа переписки нет, и без
  // этой ветки её адрес читался бы как «владелец не открыл переход по имени»
  // — то есть как имя человека, до которого не достучаться.
  if (answer.subject) {
    return { status: 'space', kind: answer.subject.kind, publicId: answer.subject.id, username };
  }
  if (!answer.peerPubB64) return { status: 'unlisted' };
  // Сверка идёт ПОСЛЕ всех отказов: запоминать нечего у имени, по которому
  // никуда не перешли, а запись в базу на каждый промах выдавала бы её объём
  // за число знакомств.
  const pin = await checkUsernameKeyPin(username, answer.peerPubB64);
  return {
    status: 'stranger',
    peerPubB64: answer.peerPubB64,
    username,
    peerName: answer.peerName,
    keyChangedSince: pin.status === 'changed' ? pin.since : null,
  };
}

/** Что показать человеку, когда переходить некуда. */
export function mentionMissText(
  status: 'ambiguous' | 'space' | 'unclaimed' | 'unlisted' | 'unconfigured' | 'unknown',
  name: string,
  /** Вид предмета — только для `space`: «группы» и «канала» это разные слова. */
  kind?: 'group' | 'channel',
): string {
  switch (status) {
    case 'space':
      // Переход сюда ещё не сделан, и обещать его текстом нельзя. Сказать при
      // этом надо честно: имя существует, просто за ним не человек.
      return `@${name} — это адрес ${kind === 'channel' ? 'канала' : 'группы'}, а не человека`;
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

/**
 * То же самое, но по самому исходу (v4.32.938).
 *
 * Три экрана — переписка, группа, лента — звали `mentionMissText(hit.status,
 * bare)`, и вид предмета до текста не доезжал: канал, назвавшийся адресом,
 * объявлялся группой. Забыть его там было нечем: аргумент необязательный, а
 * `status` у исхода лежит прямо под рукой. Здесь забыть нечего — исход
 * передаётся целиком.
 */
export function mentionMissTextFor(hit: MentionTarget, name: string): string {
  if (hit.status === 'contact' || hit.status === 'stranger') {
    // Промаха нет: сюда ходят только там, где переходить некуда. Молчать
    // всё же нельзя — пустая строка на экране выглядит поломкой.
    return `Не удалось открыть @${name}`;
  }
  return mentionMissText(hit.status, name, hit.status === 'space' ? hit.kind : undefined);
}
