/**
 * Отправка в группу отвечает за то, сохранилась ли строка (v4.32.893).
 *
 * Дефект: тринадцать мест писали `await insertGroupMessage(row);` и выбрасывали
 * ответ. `false` здесь — не исключение (`insertGroupMessageChecked` ловит отказ
 * SQLite и возвращает `'failed'`), поэтому стоящий вокруг `catch` не срабатывал
 * и выполнение шло дальше: `touchGroupConversation` двигал строку переписки,
 * `fanoutGroupMessage` отправлял сообщение участникам, экран показывал его из
 * своего состояния, окно пересылки считало группу в «Переслано в N чатов».
 *
 * Цена: у всех остальных сообщение есть, у автора после перезапуска его нет —
 * своё же фото, документ, голосовое или опрос исчезали из групповой истории
 * без единого слова. Обратный порядок отказов даёт другое: не остаётся ничего,
 * а человеку показан успех. В личных чатах этот класс закрыт с
 * `saveChatMessageChecked`; групповая ветка осталась на молчащем вызове.
 *
 * Правка: `insertGroupMessageOrThrow` — исход исключением для тех мест, что уже
 * стоят в `try` с человеческим `showError`; им нужно не различать исходы, а
 * прерваться ДО рассылки. Два места правятся иначе и намеренно: обработчик
 * карточки контакта не обёрнут в `try` (бросать нечему поймать), а перебор в
 * окне пересылки исключением оборвался бы, потеряв уже посчитанное.
 *
 * Проверяется форма исходника: и экран групп, и лента в тестах не монтируются
 * (их деревья тянут карты, камеру и звук), а спорное здесь — порядок двух
 * строк внутри каждого обработчика. Положительные контроли ниже держат вырезки.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..');
/** Файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (rel: string): string =>
  fs
    .readFileSync(path.join(SRC, rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
const count = (s: string, needle: string): number => s.split(needle).length - 1;

const SENDERS = [
  'ui/screens/GroupsScreen.tsx',
  'ui/screens/FeedScreen.tsx',
  'ui/components/modals/chat/ChatForwardModal.tsx',
];

describe('несохранённое сообщение больше не рассылается как отправленное', () => {
  it('ни одного молчащего `await insertGroupMessage(row);` в отправляющих местах', () => {
    for (const rel of SENDERS) {
      expect([rel, bare(rel).includes('await insertGroupMessage(row);')]).toEqual([rel, false]);
    }
  });

  it('экран групп: девять отправок переведены на бросающую обёртку', () => {
    const s = bare('ui/screens/GroupsScreen.tsx');
    expect(count(s, 'await insertGroupMessageOrThrow(row);')).toBe(9);
    expect(s).toContain('  insertGroupMessageOrThrow,');
  });

  it('у каждой из девяти рассылка стоит ПОСЛЕ записи, а не до', () => {
    const s = bare('ui/screens/GroupsScreen.tsx');
    let from = 0;
    const seen: number[] = [];
    for (;;) {
      const at = s.indexOf('await insertGroupMessageOrThrow(row);', from);
      if (at < 0) break;
      const tail = s.slice(at, at + 900);
      // `announceGroupSend(fanoutGroupMessage(` — единственный способ, которым
      // групповое сообщение уходит участникам с этих экранов.
      const ann = tail.indexOf('announceGroupSend(');
      expect(ann).toBeGreaterThan(0);
      expect(tail.indexOf('fanoutGroupMessage(', ann)).toBeGreaterThan(ann);
      seen.push(at);
      from = at + 1;
    }
    expect(seen).toHaveLength(9);
  });

  it('карточка контакта: обработчик без `try`, поэтому проверка на месте', () => {
    const s = bare('ui/screens/GroupsScreen.tsx');
    const at = s.indexOf('const handleGroupShareContact = useCallback(async (c: {');
    expect(at).toBeGreaterThan(0);
    const end = s.indexOf('const handleGroupPickQuickReply = useCallback(', at);
    expect(end).toBeGreaterThan(at);
    const h = s.slice(at, end);
    // Обработчик и правда не обёрнут — иначе правка должна была быть другой.
    expect(h).not.toContain('try {');
    const guard = h.indexOf('if (!(await insertGroupMessage(row))) {');
    expect(guard).toBeGreaterThan(0);
    const tail = h.slice(guard, guard + 300);
    const said = tail.indexOf(
      "showError('Не удалось сохранить карточку на устройстве — отправка отменена');"
    );
    expect(said).toBeGreaterThan(0);
    expect(tail.indexOf('return;', said)).toBeGreaterThan(said);
    // И выход стоит до рассылки и до строки переписки.
    expect(h.indexOf('announceGroupSend(fanoutGroupMessage(')).toBeGreaterThan(guard);
    expect(h.indexOf('await touchGroupConversation(')).toBeGreaterThan(guard);
  });

  it('окно пересылки: отказ базы уходит в причины, а перебор продолжается', () => {
    const s = bare('ui/components/modals/chat/ChatForwardModal.tsx');
    const guard = s.indexOf('if (!(await insertGroupMessage(row))) {');
    expect(guard).toBeGreaterThan(0);
    const tail = s.slice(guard, guard + 260);
    expect(tail).toContain('denied.push(`«${group.name}» — не удалось сохранить на устройстве`);');
    expect(tail).toContain('continue;');
    // Ни рассылки, ни `sent += 1` до проверки.
    expect(s.indexOf('await fanoutGroupMessage(group.id, msgText,')).toBeGreaterThan(guard);
  });

  it('лента: перехват перестал быть глухим и называет причину', () => {
    const s = bare('ui/screens/FeedScreen.tsx');
    expect(s).toContain('await insertGroupMessageOrThrow(row);');
    expect(s).toContain("showError(userErrorText(e, t('feed.sendFailed')));");
  });

  it('обёртка бросает только на отказе, повтор отказом не считает', () => {
    const s = bare('core/storage/local.ts');
    const at = s.indexOf('export async function insertGroupMessageOrThrow(');
    expect(at).toBeGreaterThan(0);
    const body = s.slice(at, at + 320);
    expect(body).toContain("if ((await insertGroupMessageChecked(msg)) === 'failed') {");
    expect(body).toContain(
      "throw new Error('Не удалось сохранить сообщение на устройстве — отправка отменена');"
    );
  });

  it('текст исключения доходит до экрана: он кириллический и однострочный', () => {
    // Иначе `userErrorText` заменит его запасным — и правка снова промолчит
    // о том, ЧТО именно не получилось.
    const { isUserFacingMessage } = require('../components/userErrorText') as {
      isUserFacingMessage: (t: string) => boolean;
    };
    expect(isUserFacingMessage('Не удалось сохранить сообщение на устройстве — отправка отменена')).toBe(true);
    expect(isUserFacingMessage('Не удалось сохранить карточку на устройстве — отправка отменена')).toBe(true);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: отправка осталась отправкой', () => {
  it('все девять видов сообщений по-прежнему уходят в группу', () => {
    const s = bare('ui/screens/GroupsScreen.tsx');
    for (const preview of ['🎬 Видео', '📷 Фото', '📍 Геолокация', '🎞 GIF', '🎤 Голосовое сообщение', '📊 Опрос']) {
      expect([preview, s.includes(preview)]).toEqual([preview, true]);
    }
    expect(count(s, 'announceGroupSend(fanoutGroupMessage(')).toBeGreaterThanOrEqual(9);
  });

  it('человеческие запасные тексты у отправок целы', () => {
    const s = bare('ui/screens/GroupsScreen.tsx');
    for (const t of [
      "userErrorText(e, 'Не удалось отправить сообщение')",
      "userErrorText(e, 'Не удалось отправить документ')",
      "userErrorText(e, 'Не удалось отправить геолокацию')",
      "userErrorText(e, 'Не удалось отправить GIF')",
      "userErrorText(e, 'Не удалось отправить опрос')",
    ]) {
      expect([t, s.includes(t)]).toEqual([t, true]);
    }
  });

  it('окно пересылки: прежние причины отказа и счёт чатов на месте', () => {
    const s = bare('ui/components/modals/chat/ChatForwardModal.tsx');
    expect(s).toContain('const verdict = await groupSendVerdict(group.id, myPub, msgText);');
    expect(s).toContain('denied.push(`«${group.name}» — ${verdict.reason.toLowerCase()}`);');
    expect(s).toContain("showSuccess(`Переслано в ${sent} ${ruPlural(sent, ['чат', 'чата', 'чатов'])}`);");
    expect(s).toContain('if (partial.length > 0) showError(`Дошло не всем: ${partial.join(\'; \')}`);');
  });

  it('правка v4.32.892 в корзине не задета', () => {
    const s = bare('ui/screens/GroupsScreen.tsx');
    expect(s).toContain(
      "showError('Не удалось восстановить сообщение. Оно осталось в «Недавно удалённых»');"
    );
  });

  it('системные строки группы намеренно оставлены на прежнем вызове', () => {
    // Системная строка («переименовал группу») — не текст человека: её потеря
    // не уносит написанного и не расходится с тем, что видят участники,
    // потому что каждый пишет её себе сам. Блэст-радиус другой, и правка тоже.
    const s = bare('ui/utils/groupSysMessage.ts');
    expect(s).toContain('await insertGroupMessage({');
    expect(s).toContain('text: makeGroupSysText(event),');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('`insertGroupMessage` при отказе базы всё так же отвечает `false`', () => {
    const s = bare('core/storage/local.ts');
    expect(s).toContain('export async function insertGroupMessage(msg: GroupMessageRow): Promise<boolean> {');
    expect(s).toContain("return (await insertGroupMessageChecked(msg)) === 'inserted';");
    const at = s.indexOf('export async function insertGroupMessageChecked(');
    const body = s.slice(at, at + 900);
    expect(body).toContain('} catch (e) {');
    expect(body).toContain("return 'failed';");
    expect(body).not.toContain('throw e;');
  });

  it('в личных чатах тот же класс закрыт проверяемой записью', () => {
    const s = bare('core/social/messaging.ts');
    expect(s).toContain('saveChatMessageChecked');
  });

  it('рассылка участникам от записи в базу не зависит — её надо опережать', () => {
    const s = bare('core/social/groupMessaging.ts');
    expect(s).toContain('export async function fanoutGroupMessage(');
    expect(s).not.toContain('insertGroupMessageOrThrow');
  });
});
