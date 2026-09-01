/**
 * v4.32.439: очередь публикации постов — записи помечены автором.
 *
 * Очередь `feed_publish_queue_v2` лежит в ОДНОЙ записи kv на всё приложение,
 * а разбирает её тот ключ, который активен в момент разбора. Без отметки автора
 * запись личного профиля забирал рабочий: пост без postId уходил в эфир заново
 * подписанным чужим ключом рабочим контактам, а пост с postId просто исчезал —
 * `getPost` не находил его в ленте активного профиля, и это читалось как
 * «автор удалил пост локально».
 *
 * Тест сторожит форму исправления в исходнике: отметку в типе, её простановку
 * внутри постановщика в очередь, проверку владельца ПЕРЕД любой отправкой и
 * то, что чужая запись не тратит попытку.
 */
import fs from 'fs';
import path from 'path';

const SERVICE = path.join(__dirname, '..', 'feedService.ts');
const source = fs.readFileSync(SERVICE, 'utf8');

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

/** Строки кода без комментариев — чтобы пояснения не подменяли собой проверку. */
function codeLines(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

describe('очередь публикации постов помечена автором', () => {
  it('в типе записи есть отметка автора', () => {
    const type = bodyOf(source, 'type QueuedFeedItem = {');
    expect(codeLines(type).some((l) => l.trim() === 'authorDid?: string;')).toBe(true);
  });

  it('постановщик в очередь берёт автора из ключа, а не из аргумента', () => {
    const head = 'async function enqueuePendingFeedPost(pair: KeyPairBytes, data: {';
    expect(source).toContain(head);
    const body = bodyOf(source, head);
    const code = codeLines(body);
    // did выводится внутри, из переданной пары ключей
    expect(code.some((l) => l.includes('const authorDid = publicKeyToDidKey(pair.publicKey);'))).toBe(true);
    // и попадает в саму запись
    expect(code.some((l) => l.trim() === 'authorDid,')).toBe(true);
    // аргумент data не может нести authorDid — его там просто нет в типе
    const argType = body.slice(0, body.indexOf('}): Promise<void>'));
    expect(argType).not.toContain('authorDid');
  });

  it('все вызовы постановщика передают пару ключей', () => {
    const withPair = source.match(/enqueuePendingFeedPost\(pair, \{/g) ?? [];
    const withoutPair = source.match(/enqueuePendingFeedPost\(\{/g) ?? [];
    // v4.32.554: третий вызов — репост, он тоже кладётся в эту очередь.
    expect(withPair.length).toBe(3);
    expect(withoutPair.length).toBe(0);
  });

  it('дедуп по postId не смешивает записи разных профилей', () => {
    const body = bodyOf(source, 'async function enqueuePendingFeedPost(pair: KeyPairBytes, data: {');
    const dedupe = body.slice(body.indexOf('const existingIdx'), body.indexOf('const hasPostId'));
    expect(dedupe).toContain('x.postId === data.postId');
    expect(dedupe).toContain('x.authorDid === undefined || x.authorDid === authorDid');
  });

  it('проверка владельца стоит раньше любой отправки', () => {
    const body = bodyOf(source, 'async function republishQueuedItem(');
    const code = codeLines(body);
    const guard = code.findIndex((l) =>
      l.includes("typeof item.authorDid === 'string' && item.authorDid !== myDid"));
    const legacySend = code.findIndex((l) => l.includes('tryPublishFeedPostComplete('));
    const broadcast = code.findIndex((l) => l.includes('signAndBroadcastFeedEnvelope('));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(legacySend).toBeGreaterThan(guard);
    expect(broadcast).toBeGreaterThan(guard);
    // отказ помечен отдельно от «не доставлено»
    expect(body).toContain('foreign?: boolean');
    expect(code[guard + 1]).toContain('return { fullyDelivered: false, foreign: true };');
  });

  it('неразмеченная запись не публикуется вслепую и не стирается', () => {
    const body = bodyOf(source, 'async function republishQueuedItem(');
    const code = codeLines(body);
    // без postId — отправлять от активного ключа нечего проверить, значит не отправляем
    const noPostId = code.findIndex((l) => l.includes('if (!item.postId) {'));
    const unowned = code.findIndex((l) => l.includes("log.warn('feed_queue_legacy_unowned_kept'"));
    const legacySend = code.findIndex((l) => l.includes('tryPublishFeedPostComplete('));
    expect(noPostId).toBeGreaterThanOrEqual(0);
    expect(unowned).toBeGreaterThan(noPostId);
    expect(legacySend).toBeGreaterThan(unowned);
    // с postId, но поста нет в ленте активного профиля — это чужая запись, не «удалён автором»
    const foreignKept = code.findIndex((l) => l.includes("log.info('feed_queue_legacy_foreign_kept'"));
    const drop = code.findIndex((l) => l.includes("log.info('feed_queue_postId_missing_drop'"));
    expect(foreignKept).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(foreignKept);
  });

  it('чужая запись не тратит попытку при общем flush', () => {
    const body = bodyOf(source, 'async function _flushFeedPublishQueueImpl(');
    const code = codeLines(body);
    const foreign = code.findIndex((l) => l.includes('if (result.foreign) return item;'));
    const burn = code.findIndex((l) => l.includes('retries: item.retries + 1'));
    expect(foreign).toBeGreaterThanOrEqual(0);
    expect(burn).toBeGreaterThan(foreign);
  });

  it('проверки ловят прежний вид кода (не вакуумны)', () => {
    const oldRepublish = [
      'async function republishQueuedItem(',
      '  pair: KeyPairBytes,',
      '  item: QueuedFeedItem,',
      '): Promise<{ fullyDelivered: boolean }> {',
      '  if (!item.postId) {',
      '    const tryRes = await tryPublishFeedPostComplete(pair, { text: item.text });',
      '    return { fullyDelivered: !!tryRes.postId };',
      '  }',
      '  const existing = await s.getPost(item.postId);',
      '  if (!existing) {',
      "    log.info('feed_queue_postId_missing_drop', { id: item.id });",
      '    return { fullyDelivered: true };',
      '  }',
      '  const res = await signAndBroadcastFeedEnvelope(pair, payload, broadcastOpts);',
      '  return { fullyDelivered: false };',
      '}',
    ].join('\n');
    const code = codeLines(bodyOf(oldRepublish, 'async function republishQueuedItem('));
    expect(code.some((l) => l.includes('item.authorDid !== myDid'))).toBe(false);
    expect(oldRepublish).not.toContain('foreign?: boolean');
    expect(code.some((l) => l.includes("log.info('feed_queue_legacy_foreign_kept'"))).toBe(false);

    const oldEnqueue = 'await enqueuePendingFeedPost({\n  postId,\n});';
    expect((oldEnqueue.match(/enqueuePendingFeedPost\(\{/g) ?? []).length).toBe(1);
    expect((oldEnqueue.match(/enqueuePendingFeedPost\(pair, \{/g) ?? []).length).toBe(0);
  });
});
