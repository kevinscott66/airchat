/**
 * Повтор из очереди собирает тот же конверт, что и первая отправка (v4.32.614).
 *
 * Сборка конверта своей записи была написана дважды: один раз для копии по
 * ссылке, второй — прямо в повторе из очереди. Копии разошлись по трём местам,
 * и каждое расхождение выходило человеку боком.
 *
 * Документы вторая сборка не отправляла вовсе: запись, выложенная без сети,
 * доходила до контактов без приложенных файлов, и вернуть их было нечем.
 * Текст она брала из очереди — в том виде, в каком запись выложили; правка,
 * сделанная пока запись лежала в очереди, повтором отменялась. Проверки на
 * нечитаемые ячейки в ней не было: запись, которую не открывает ключ этого
 * устройства, уходила контактам заглушкой, подписанной нашим ключом.
 *
 * Проверяется текстом файла, а не вызовом: republishQueuedItem не вывезен
 * наружу, и вывозить его ради теста значит открыть путь в очередь мимо
 * проверки владельца, которая в нём же и стоит.
 */
import fs from 'fs';
import path from 'path';

const SRC = (): string => fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function bodyOf(src: string, head: string, next: string): string {
  const a = src.indexOf(head);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(next, a + head.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const republish = (): string =>
  bodyOf(SRC(), 'async function republishQueuedItem(', '\nfunction runFlushExclusively(');

const builder = (): string =>
  bodyOf(SRC(), 'async function buildOwnPostEnvelope(', '\n/**\n * Выложить копию своей публикации');

describe('повтор из очереди', () => {
  it('берёт конверт у общей сборки', () => {
    expect(republish()).toContain('const payload = await buildOwnPostEnvelope(pair, item.postId, {');
  });

  it('не собирает конверт заново', () => {
    const body = republish();
    expect(body).not.toContain("type: 'feed_post',");
    expect(body).not.toContain("type: 'feed_repost',");
    expect(body).not.toContain("kind: 'post',");
    expect(body).not.toContain("kind: 'repost',");
  });

  it('текст берётся из ленты, а не из очереди — иначе повтор отменяет правку', () => {
    // Только та часть, где пост уже найден в ленте. Выше по функции лежит путь
    // для items без postId — там ленты нет и брать текст неоткуда, кроме очереди.
    const body = republish();
    const known = body.slice(body.indexOf('const existing = await own.getPost(item.postId);'));
    expect(known.length).toBeGreaterThan(0);
    expect(known).not.toContain('item.text');
  });

  it('нечитаемую запись не отправляет и попытку на неё не тратит', () => {
    const body = republish();
    expect(body).toContain('feed_queue_envelope_unavailable_kept');
    expect(body).toContain('return { fullyDelivered: false, foreign: true };');
  });
});

describe('общая сборка конверта', () => {
  it('принимает запасные вложения для items из версий до v4.32.66', () => {
    const body = builder();
    expect(body).toContain('legacy?: { base64?: string[]; mimes?: string[]; authorName?: string },');
    expect(body).toContain('if (media.length === 0 && legacy?.base64 && legacy.base64.length > 0) {');
  });

  it('имя автора не пропадает у старых items', () => {
    expect(builder()).toContain("const authorName = existing.authorName ?? legacy?.authorName ?? '';");
  });

  it('нечитаемую запись наружу не отдаёт — и очередь теперь идёт через эту же проверку', () => {
    const body = builder();
    expect(body).toContain('existing.textUnreadable || existing.mediaUnreadable');
    expect(body).toContain("log.warn('public_post_unreadable_skip'");
  });

  it('документы кладутся в конверт — из-за них очередь и расходилась', () => {
    expect(builder()).toContain('documents: documents.length > 0 ? documents : undefined,');
  });
});
