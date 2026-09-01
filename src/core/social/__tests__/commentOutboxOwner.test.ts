import * as fs from 'fs';
import * as path from 'path';

/**
 * Недоставленный коммент не меняет автора при смене профиля (v4.32.438).
 *
 * Очередь недоставленных комментов лежит в ОДНОЙ записи kv на всё приложение
 * (feed_comment_outbox_v1, без области профиля), а разбирает её тот ключ,
 * который активен в момент разбора: resumeCommentOutbox зовут при привязке
 * личности и при восстановлении сети. Значит коммент, написанный из личного
 * профиля и не доехавший, при следующем входе в рабочий профиль уходил
 * подписанным РАБОЧИМ ключом и рабочим контактам. Текст чужой, автор — другая
 * личность; разделение профилей на этом месте не работало вовсе.
 *
 * Тест исходный: чтобы завести живой feedService, нужны транспорт, база и
 * ключи, а правило здесь — про порядок проверок и про то, кто проставляет
 * автора.
 */
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');

function bodyOf(source: string, head: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.includes(head));
  if (start < 0) return '';
  let end = start;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

function codeLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

describe('запись очереди знает своего автора', () => {
  it('поле есть в типе', () => {
    const type = bodyOf(SOURCE, 'type CommentOutboxItem = {');
    expect(type).toContain('authorDid: string;');
  });

  it('автор проставляется внутри постановки в очередь, а не вызывающим', () => {
    const body = bodyOf(SOURCE, 'async function enqueueCommentOutboxItem(');
    expect(body).toContain('pair: KeyPairBytes');
    expect(body).toContain('const authorDid = publicKeyToDidKey(pair.publicKey);');
    // Вызывающий физически не может передать чужого автора: поле исключено
    // из его половины записи.
    expect(body).toContain("'key' | 'retries' | 'createdAt' | 'authorDid'");
  });

  it('ни одно место постановки не передаёт автора руками', () => {
    const calls = SOURCE.split('enqueueCommentOutboxItem(pair, {').length - 1;
    expect(calls).toBe(3);
    expect(SOURCE).not.toContain('enqueueCommentOutboxItem({');
  });

  it('записи без автора (до этой версии) не разъезжаются под чужой подписью', () => {
    const body = bodyOf(SOURCE, 'async function loadCommentOutbox(');
    expect(body).toContain("!r.authorDid.startsWith('did:')");
  });
});

describe('разбор очереди не трогает чужие записи', () => {
  const FLUSH = bodyOf(SOURCE, 'async function _flushCommentOutboxImpl(');

  it('чужая запись отсекается до отправки и остаётся в очереди', () => {
    const code = codeLines(FLUSH);
    const guard = code.indexOf('if (item.authorDid !== myDid) {');
    const send = code.findIndex((l) => l.includes('signAndBroadcastFeedEnvelope('));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(send).toBeGreaterThan(guard);
    // Именно «оставить», а не continue без сохранения: запись ждёт своего
    // профиля. С v4.32.471 итог рассылки — решение по записи, а не массив kept.
    expect(code.slice(guard, send)).toContain('keep(item);');
  });

  it('чужая запись не тратит попытку', () => {
    const code = codeLines(FLUSH);
    const guard = code.indexOf('if (item.authorDid !== myDid) {');
    const tail = code.slice(guard, guard + 4);
    expect(tail.some((l) => l.includes('retries: item.retries + 1'))).toBe(false);
  });

  it('проверка не пустая: прежняя редакция разбора не проходит', () => {
    const before = [
      'async function _flushCommentOutboxImpl(pair: KeyPairBytes): Promise<void> {',
      '  const q = await loadCommentOutbox();',
      '  const myDid = publicKeyToDidKey(pair.publicKey);',
      '  for (const item of q) {',
      '    const res = await signAndBroadcastFeedEnvelope(pair, payload);',
      '  }',
      '}',
    ].join('\n');
    const code = codeLines(bodyOf(before, 'async function _flushCommentOutboxImpl('));
    expect(code.indexOf('if (item.authorDid !== myDid) {')).toBe(-1);
    expect(code.findIndex((l) => l.includes('signAndBroadcastFeedEnvelope('))).toBeGreaterThan(0);
  });
});
