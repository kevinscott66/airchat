/**
 * Просмотр записи в ленте отмечался один раз — и не тем, кем надо (v4.32.537).
 *
 * Дефект — три сросшихся.
 *
 * 1. Отметка «автору уже сообщено» лежала под общим именем `feed_view_sent:<id>`
 *    без номера профиля. На одном телефоне два аккаунта: первый посмотрел
 *    запись — и закрыл вопрос за второго, автор навсегда недосчитывался
 *    половины зрителей. Та же беда с уборкой: удаление профиля сметает только
 *    `p<id>:%`, общее имя переживало удаление и доставалось следующему
 *    аккаунту с тем же номером.
 *
 * 2. `notifyFeedPostViewed` ставила отметку ТОЛЬКО при успешной доставке —
 *    расчёт был на повтор при следующем открытии. Повтора не было никогда:
 *    экран вносил запись в свой session-кеш ДО вызова и не убирал оттуда.
 *    Автор, оказавшийся оффлайн в момент просмотра, терял просмотр насовсем.
 *
 * 3. `markFeedPostRead` гасила любую ошибку и возвращала `void`. Экран так же
 *    помечал запись заранее, поэтому непрошедший UPDATE расходил счётчик
 *    непрочитанного с лентой до конца сессии — молча, без строки в журнале.
 *    Ручная отметка из меню записи вдобавок ничего не сообщала человеку.
 *
 * Плюс к тому оба session-кеша были `Set<string>` без потолка: за долгую
 * прокрутку они набирали идентификатор каждой виденной записи и не отдавали
 * память.
 */
import fs from 'fs';
import path from 'path';
import { feedViewSentKey, profileScopedKey } from '../../storage/kvKeys';
import { createReceiptClaims } from '../receiptClaim';

const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
const SCREEN = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'),
  'utf8',
);
const RU = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'i18n', 'ru.json'),
  'utf8',
);

/** Тело объявления: от строки-заголовка до первой закрывающей скобки в нулевой колонке. */
function bodyOf(src: string, head: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  expect(start).toBeGreaterThanOrEqual(0);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`no terminator for ${head}`);
}

const NOTIFY = bodyOf(SERVICE, 'export async function notifyFeedPostViewed(');
const MARK_READ = bodyOf(SERVICE, 'export async function markFeedPostRead(');

describe('имя отметки о просмотре', () => {
  it('строится в одном месте и в прежнем виде', () => {
    expect(feedViewSentKey('abc')).toBe('feed_view_sent:abc');
  });

  it('под номером профиля не пересекается между аккаунтами', () => {
    const a = profileScopedKey(1, feedViewSentKey('post-1'));
    const b = profileScopedKey(2, feedViewSentKey('post-1'));
    expect(a).not.toBe(b);
    expect(b).toBe('p2:feed_view_sent:post-1');
  });

  it('разные записи одного профиля тоже не пересекаются', () => {
    expect(profileScopedKey(2, feedViewSentKey('a'))).not.toBe(
      profileScopedKey(2, feedViewSentKey('b')),
    );
  });

  it('лента больше не набирает это имя у себя', () => {
    expect(SERVICE).not.toContain('`feed_view_sent:${');
    expect(SERVICE).toContain('feedViewSentKey(post.id)');
  });
});

describe('отправка просмотра автору', () => {
  it('читает и пишет отметку под номером профиля зрителя', () => {
    expect(NOTIFY).toContain('scopedKvTryGetFor(viewerPid, guardKey)');
    expect(NOTIFY).toContain("scopedKvSetFor(viewerPid, guardKey, '1')");
  });

  it('номер берётся от ключа отправителя, а не от того, что открыто на экране', () => {
    expect(NOTIFY).toContain('ownerPidByDid(');
    expect(NOTIFY).toContain('myDid,');
  });

  it('общая запись больше не читается и не пишется', () => {
    expect(NOTIFY).not.toContain('kvGet(guardKey)');
    expect(NOTIFY).not.toContain('kvSet(guardKey');
  });

  it('сообщает вызывающему, закрыт ли вопрос', () => {
    expect(SERVICE).toContain('): Promise<boolean> {\n  try {\n    const myDid = publicKeyToDidKey');
    expect(NOTIFY).toContain('return true;');
    expect(NOTIFY).toContain('return false;');
    // Ни одного немого выхода не осталось.
    expect(NOTIFY).not.toMatch(/^\s*return;\s*$/m);
  });

  it('недоставленный просмотр отвечает «нет», а не ставит отметку', () => {
    const set = NOTIFY.indexOf('scopedKvSetFor(');
    const noRoute = NOTIFY.indexOf('feed_view_send_no_route');
    expect(set).toBeGreaterThan(0);
    expect(noRoute).toBeGreaterThan(set);
    expect(NOTIFY.slice(noRoute)).toContain('return false;');
  });

  it('сорванная отправка тоже отвечает «нет»', () => {
    const caught = NOTIFY.indexOf('feed_view_notify_failed');
    expect(caught).toBeGreaterThan(0);
    expect(NOTIFY.slice(caught)).toContain('return false;');
  });

  it('нечитаемая отметка не гасит отправку молча', () => {
    expect(NOTIFY).toContain('feed_view_guard_unreadable');
  });

  it('неизвестный номер профиля не пишет отметку наугад', () => {
    expect(NOTIFY).toContain('feed_view_pid_unknown');
    expect(NOTIFY).toContain('if (viewerPid !== null) await scopedKvSetFor(');
    // Подстановка «первого профиля» — ровно тот способ отнять просмотр
    // у соседнего аккаунта, от которого этот круг и лечит.
    expect(NOTIFY).not.toContain('?? 1;');
  });
});

describe('локальная отметка «прочитано»', () => {
  it('возвращает исход, а не void', () => {
    expect(MARK_READ).toContain('Promise<boolean>');
    expect(MARK_READ).toContain('return true;');
    expect(MARK_READ).toContain('return false;');
  });

  it('провал попадает в журнал, а не в пустой перехват', () => {
    expect(MARK_READ).toContain("log.warn('feed_mark_read_failed'");
    expect(MARK_READ).not.toContain('/* noop */');
  });
});

describe('экран ленты', () => {
  it('оба session-кеша больше не безразмерные множества', () => {
    expect(SCREEN).not.toContain('const sentViewRef = useRef<Set<string>>(new Set())');
    expect(SCREEN).not.toContain('const markedReadRef = useRef<Set<string>>(new Set())');
    expect(SCREEN).toContain('const sentViewRef = useRef(createReceiptClaims())');
    expect(SCREEN).toContain('const markedReadRef = useRef(createReceiptClaims())');
  });

  it('смена профиля по-прежнему обнуляет оба', () => {
    expect(SCREEN).toContain('sentViewRef.current = createReceiptClaims();');
    expect(SCREEN).toContain('markedReadRef.current = createReceiptClaims();');
  });

  it('заявка на просмотр снимается, если отправка не прошла', () => {
    const claim = SCREEN.indexOf('sentViewRef.current.claim([post.id])');
    const send = SCREEN.indexOf('notifyFeedPostViewed(ctx.pair,');
    const release = SCREEN.indexOf('sentViewRef.current.release([viewId])');
    expect(claim).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(claim);
    expect(release).toBeGreaterThan(send);
  });

  it('заявка на «прочитано» снимается, если запись не легла в базу', () => {
    const claim = SCREEN.indexOf('markedReadRef.current.claim([post.id])');
    const release = SCREEN.indexOf('markedReadRef.current.release([readId])');
    expect(claim).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(claim);
  });

  it('сорванный обещанием вызов тоже снимает заявку', () => {
    expect(SCREEN).toMatch(/\.catch\(\(\) => \{\s*\n\s*sentViewRef\.current\.release/);
  });

  it('ручная отметка сообщает человеку о провале', () => {
    expect(SCREEN).toContain("showError(t('feed.markReadFailed'))");
    expect(RU).toContain('"markReadFailed"');
  });

  it('прежнее «добавил и забыл» из экрана ушло', () => {
    expect(SCREEN).not.toContain('sentViewRef.current.add(');
    expect(SCREEN).not.toContain('markedReadRef.current.add(');
    expect(SCREEN).not.toContain('sentViewRef.current.has(');
    expect(SCREEN).not.toContain('markedReadRef.current.has(');
  });
});

describe('повторная попытка, на которую рассчитан экран', () => {
  it('снятая заявка позволяет попробовать снова, оставленная — нет', () => {
    const claims = createReceiptClaims();
    expect(claims.claim(['p1'])).toEqual(['p1']);
    expect(claims.claim(['p1'])).toEqual([]);
    claims.release(['p1']);
    expect(claims.claim(['p1'])).toEqual(['p1']);
  });

  it('прокрутка длиной в тысячу записей не растит кеш без предела', () => {
    const claims = createReceiptClaims(64);
    for (let i = 0; i < 1000; i += 1) claims.claim([`p${i}`]);
    expect(claims.size()).toBeLessThanOrEqual(64);
  });
});
