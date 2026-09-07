import * as fs from 'fs';
import * as path from 'path';

/**
 * v4.32.615: сбой справочника контактов больше не выбрасывает запись из очереди.
 *
 * Повтор рассылки заканчивается подсчётом: сколько контактов ещё не получили
 * запись. Подсчёт спрашивает `listContacts()`, и вокруг него стоит `catch`.
 * В нём возвращалось «доставлено всем», если хотя бы один адресат ответил
 * успехом, — и вызывающий проход снимал запись с очереди навсегда.
 *
 * Оговорка досталась от версий до v4.32.67, когда накопителя `deliveredTo` не
 * существовало: оставленная запись рассылалась заново всем подряд, включая уже
 * получивших. Накопитель появился, повтор идёт мимо доставленных — а вот
 * потеря по-прежнему необратима. Из пяти контактов конверт ушёл одному, база
 * контактов споткнулась, и четверо не получат запись никогда: ни по таймеру
 * повтора, ни по обнаружению в сети, ни через две недели.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

/** Тело функции: от её заголовка до строки `\n}` на нулевом отступе. */
function bodyOf(head: string): string {
  const start = SRC.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

const BODY = bodyOf('async function republishQueuedItem(');

/** Строки кода без комментариев — иначе объяснение сойдёт за сам код. */
function codeOf(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const CODE = codeOf(BODY);

describe('сбой подсчёта контактов не теряет запись', () => {
  test('в catch не остаётся «хоть один успех — значит всем»', () => {
    expect(CODE).not.toContain('res.delivered.success > 0 && !optsTarget');
    expect(CODE).not.toMatch(/catch[\s\S]{0,400}fullyDelivered: res\.delivered\.success/);
  });

  test('catch отдаёт «не доставлено» и объясняет это в логе', () => {
    expect(CODE).toContain("log.warn('feed_queue_contacts_count_failed_kept'");
    expect(CODE).toMatch(
      /log\.warn\('feed_queue_contacts_count_failed_kept'[\s\S]{0,400}\n\s*return \{ fullyDelivered: false \};/,
    );
  });

  test('«доставлено всем» остаётся только у настоящего подсчёта', () => {
    // Два места на всю функцию: пост удалён автором локально (повторять
    // нечего) и «контактов нет вовсе». Ни одно из них не догадка.
    const trues = CODE.match(/fullyDelivered: true/g) ?? [];
    expect(trues.length).toBe(2);
    expect(CODE).toContain('log.info(\'feed_queue_postId_missing_drop\'');
    expect(CODE).toContain('if (allContactDids.size === 0) return { fullyDelivered: true };');
    expect(CODE).toContain('return { fullyDelivered: remaining === 0 };');
  });

  test('накопитель доставленных заполняется ДО подсчёта', () => {
    // Именно поэтому оставить запись теперь дёшево: следующий повтор вычтет
    // уже получивших через skipDids и не разошлёт конверт им повторно.
    const acc = CODE.indexOf('item.deliveredTo = [...acc];');
    const count = CODE.indexOf('const contacts = await listContacts();');
    expect(acc).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(acc);
    expect(CODE).toContain('const skipDids = new Set(item.deliveredTo ?? []);');
  });
});

describe('проверка не пустая', () => {
  /** Что делал вызывающий проход с ответом повтора. */
  const dropsFromQueue = (fullyDelivered: boolean): boolean => fullyDelivered;

  const CONTACTS = ['did:a', 'did:b', 'did:c', 'did:d', 'did:e'];
  const deliveredNow = ['did:a'];

  test('старое правило теряло запись после единственного успеха', () => {
    const before = deliveredNow.length > 0; // res.delivered.success > 0 && !optsTarget
    expect(dropsFromQueue(before)).toBe(true);
    const missed = CONTACTS.filter((d) => !deliveredNow.includes(d));
    expect(missed).toEqual(['did:b', 'did:c', 'did:d', 'did:e']);
  });

  test('новое правило оставляет запись, и повтор идёт мимо доставленного', () => {
    expect(dropsFromQueue(false)).toBe(false);
    const skip = new Set(deliveredNow);
    expect(CONTACTS.filter((d) => !skip.has(d))).toHaveLength(4);
  });
});
