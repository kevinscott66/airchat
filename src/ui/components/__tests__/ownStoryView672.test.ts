/**
 * Автор попадал в число зрителей собственной сторис (v4.32.672).
 *
 * `stories.viewed_by` показывается только автору и отвечает на вопрос «кто её
 * посмотрел». Эффект просмотра в `StoriesRow` звал `markStoryViewed` на любой
 * открытый кадр, не разбирая чей он, а `recordStoryViewInTx` дописывает
 * присланный ключ без единой проверки на авторство. Автор же открывает свою
 * сторис в первую очередь затем, чтобы посмотреть счётчик, — и тем самым
 * делал его равным единице при полном отсутствии зрителей, а первым в списке
 * посмотревших стоял он сам.
 *
 * Правка стоит на стороне экрана: путь записи один, а лишняя пишущая
 * транзакция на каждый кадр своей ленты не нужна тем более.
 *
 * `StoriesRow.tsx` в jest не поднимается (весь react-native внутри), поэтому
 * правило проверяется по исходнику — как в mentionUsernameAmbiguity и
 * memberSearch.
 */
import fs from 'fs';
import path from 'path';

const ROW = (): string =>
  fs.readFileSync(path.join(__dirname, '..', 'StoriesRow.tsx'), 'utf8');
const LOCAL = (): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'core', 'storage', 'local.ts'), 'utf8');

/**
 * Исходник без строк-комментариев: русское пояснение к правке цитирует те же
 * выражения, что и код, и подсчёт по целому файлу ловил бы их тоже.
 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('хранилище по-прежнему дописывает любого присланного зрителя', () => {
    const body = slice(LOCAL(), 'async function recordStoryViewInTx(', '\n}');
    expect(body).toMatch(/if \(!viewers\.includes\(viewerPubB64\) && viewers\.length < 500\)/);
    // Проверки на авторство там нет и не заводится: столбец author_pub_b64
    // в этот SELECT не входит.
    expect(body).toMatch(/SELECT viewed_by FROM stories WHERE id = \? AND owner_profile_id = \?/);
    expect(body).not.toMatch(/author_pub_b64/);
  });

  it('счётчик и список посмотревших показываются именно автору', () => {
    const src = codeOnly(ROW());
    expect(src).toMatch(/isOwn && viewerCount\(viewerList\) > 0/);
    expect(src).toMatch(/👁 Просмотрело \$\{viewers\.length\} чел\./);
  });

  it('путь записи из интерфейса ровно один', () => {
    expect(codeOnly(ROW()).match(/markStoryViewed\(/g)?.length).toBe(1);
  });
});

describe('своя сторис не считается просмотренной автором', () => {
  const EFFECT = (): string =>
    slice(codeOnly(ROW()), '  useEffect(() => {\n    if (!story) return;', '}, [story?.id, myPubB64, ownerProfileId]);');

  it('в эффекте просмотра стоит выход по своему ключу', () => {
    expect(EFFECT()).toMatch(/if \(story\.authorPubB64 === myPubB64\) return;/);
  });

  it('выход стоит раньше записи, а не после неё', () => {
    const body = EFFECT();
    const guard = body.indexOf('if (story.authorPubB64 === myPubB64) return;');
    const write = body.indexOf('void markStoryViewed(');
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });

  it('кружок своей группы по-прежнему гасится напрямую, а не списком зрителей', () => {
    // Правка не должна была тронуть вторую половину правила: своей ленте
    // hasUnread выставляется значением, storyRingUnread для неё не зовётся.
    const src = codeOnly(ROW());
    expect(src).toMatch(/authorPubB64: myPubB64, stories: own, hasUnread: false/);
    expect(src.match(/hasUnread: false/g)?.length).toBe(1);
    expect(src).toMatch(/const hasUnread = storyRingUnread\(/);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('оба исходника прочитаны целиком', () => {
    expect(ROW().length).toBeGreaterThan(20000);
    expect(LOCAL().length).toBeGreaterThan(100000);
  });

  it('срез эффекта — это эффект, а не весь файл', () => {
    const body = slice(codeOnly(ROW()), '  useEffect(() => {\n    if (!story) return;', '}, [story?.id, myPubB64, ownerProfileId]);');
    expect(body.length).toBeGreaterThan(40);
    expect(body.length).toBeLessThan(400);
  });
});
