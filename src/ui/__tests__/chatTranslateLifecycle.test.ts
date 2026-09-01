/**
 * Рэтчет к v4.32.541 — пачка перевода не переживает уход с экрана.
 *
 * Дефект был не в переводе, а в том, что его никто не останавливал. Двадцать
 * сообщений подряд, по восемь секунд ожидания на каждое — две с половиной
 * минуты, в течение которых уже закрытая переписка продолжала отдавать тексты
 * сообщений чужому сервису и в конце писала в состояние снятого экрана.
 * Дедупликации не было вовсе: кэш заполнялся лишь в конце пачки, поэтому
 * пришедшее в это время сообщение начинало вторую пачку с теми же текстами.
 *
 * Здесь — форма самого места (поведение счётчика занятых проверяется в
 * receiptClaim.test.ts) плюс поведенческая проверка занятия и возврата.
 */
import fs from 'fs';
import path from 'path';

import { createReceiptClaims } from '../../core/social/receiptClaim';

const CHAT = fs.readFileSync(path.join(__dirname, '../screens/ChatScreen.tsx'), 'utf8');

/** Тело useCallback: закрытия на нулевой колонке у него нет. */
function callbackBody(src: string, head: string): string {
  const start = src.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf('\n  }, [');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

const TR = (): string =>
  callbackBody(CHAT, '  const translateVisibleMessages = useCallback(async (msgs: ChatMessageRow[]) => {');

describe('перевод: пачка останавливается вместе с экраном', () => {
  it('каждый шаг цикла сверяется с тем, жив ли экран', () => {
    expect(TR()).toContain('if (!isMountedRef.current) {');
  });

  it('состояние не пишется после ухода с экрана', () => {
    const body = TR();
    const set = body.indexOf('setTranslationCache(');
    expect(set).toBeGreaterThan(-1);
    expect(body.slice(0, set)).toContain('if (!isMountedRef.current) return;');
  });

  it('согласие проверяется до всего остального, и после ожидания экран сверяется снова', () => {
    const body = TR();
    const consent = body.indexOf('await cloudTranslateAllowed()');
    const alive = body.indexOf('if (!isMountedRef.current) return;');
    expect(consent).toBeGreaterThan(-1);
    expect(alive).toBeGreaterThan(consent);
  });

  it('идущий запрос обрывается при размонтировании', () => {
    expect(CHAT).toContain('const translateAbortRef = useRef<AbortController | null>(null);');
    expect(CHAT).toContain('translateAbortRef.current?.abort();');
    expect(TR()).toContain('translateAbortRef.current = ctrl;');
  });
});

describe('перевод: один текст не уходит наружу дважды', () => {
  it('идентификаторы занимаются перед отправкой', () => {
    expect(TR()).toContain('translateClaimsRef.current.claim(batch.map((m) => m.id))');
    expect(CHAT).toContain('const translateClaimsRef = useRef(createReceiptClaims());');
  });

  it('занимается то, что реально уйдёт: отсечение по двадцать идёт раньше', () => {
    const body = TR();
    const slice = body.indexOf('toTranslate.slice(0, 20)');
    const claim = body.indexOf('.claim(');
    expect(slice).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(slice);
  });

  it('непереведённое отпускается — иначе перевод потерян до закрытия переписки', () => {
    expect(TR()).toContain('if (updates[m.id] === undefined) translateClaimsRef.current.release([m.id]);');
  });

  it('оборванный хвост очереди возвращается целиком', () => {
    const body = TR();
    const releases = body.split('translateClaimsRef.current.release(queue.slice(i)').length - 1;
    // Два выхода из цикла: экран сняли и язык испорчен.
    expect(releases).toBe(2);
  });
});

describe('счётчик занятых: то, на чём держится дедупликация', () => {
  it('повторное занятие того же идентификатора ничего не даёт', () => {
    const c = createReceiptClaims();
    expect(c.claim(['a', 'b'])).toEqual(['a', 'b']);
    expect(c.claim(['a', 'b'])).toEqual([]);
  });

  it('возвращённое можно занять снова', () => {
    const c = createReceiptClaims();
    c.claim(['a']);
    c.release(['a']);
    expect(c.claim(['a'])).toEqual(['a']);
  });

  it('вторая пачка не берёт то, что уже в работе у первой', () => {
    const c = createReceiptClaims();
    const first = c.claim(['m1', 'm2', 'm3']);
    const second = c.claim(['m2', 'm3', 'm4']);
    expect(first).toEqual(['m1', 'm2', 'm3']);
    expect(second).toEqual(['m4']);
  });
});
