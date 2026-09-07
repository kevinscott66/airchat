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

/**
 * v4.32.615: задержка повторов считалась по первой записи очереди.
 *
 * Чужая запись ждёт своего профиля и попытку не тратит — её `retries`
 * остаётся нулём. Стоя первой, она держала показатель степени на нуле, то
 * есть задержку на начальных тридцати секундах, все семь суток жизни
 * очереди: приложение будило рассылку две тысячи раз в сутки, ничего при
 * этом не отправляя.
 */
describe('задержка повторов считается по своим записям', () => {
  const TIMER = bodyOf(SOURCE, 'function scheduleCommentOutboxRetry(');
  const CODE = codeLines(TIMER).join('\n');

  it('первая запись очереди больше не задаёт задержку', () => {
    expect(TIMER).not.toContain('q[0]?.retries');
    expect(CODE).toContain('const myDid = publicKeyToDidKey(p.publicKey);');
    expect(CODE).toContain('const mine = q.filter((i) => i.authorDid === myDid);');
  });

  it('берётся наименьшее число попыток среди своих', () => {
    expect(CODE).toContain('mine.reduce((acc, i) => Math.min(acc, i.retries), Number.MAX_SAFE_INTEGER)');
    // Показатель степени и потолок остались прежними.
    expect(CODE).toContain('Math.min(RETRY_DELAY_MS * Math.pow(2, Math.min(r, 6)), 30 * 60_000)');
  });

  it('проход, которому нечего отправлять, себя не перезаводит', () => {
    const reschedule = CODE.indexOf('scheduleCommentOutboxRetry(p, nextDelay);');
    const guard = CODE.indexOf('if (mine.length > 0) {');
    expect(guard).toBeGreaterThan(-1);
    expect(reschedule).toBeGreaterThan(guard);
    // Единственная перезапись по расчётной задержке — внутри ветки своих записей.
    expect((CODE.match(/scheduleCommentOutboxRetry\(p, nextDelay\);/g) ?? []).length).toBe(1);
    // v4.32.647: вторая и последняя перезапись — возврат к прежней задержке,
    // когда очередь не прочиталась. Она стоит ДО разбора своих записей: гасить
    // таймер по нечитаемой строке значило бы бросить очередь до перезапуска.
    const unreadable = CODE.indexOf('if (q === null) {');
    expect(unreadable).toBeGreaterThan(-1);
    expect(unreadable).toBeLessThan(guard);
    expect(CODE).toContain('scheduleCommentOutboxRetry(p, delayMs);');
    expect((CODE.match(/scheduleCommentOutboxRetry\(p, /g) ?? []).length).toBe(2);
  });
});
