/**
 * Рэтчет к v4.32.536: отметка о прочтении уходит один раз на сообщение — и
 * уходит снова, только если не ушла.
 */
import fs from 'fs';
import path from 'path';

import { createReceiptClaims } from '../receiptClaim';

describe('createReceiptClaims', () => {
  it('первый раз отдаёт все, второй — ничего', () => {
    const c = createReceiptClaims();
    expect(c.claim(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(c.claim(['a', 'b', 'c'])).toEqual([]);
  });

  it('из пачки отбирает только новое, сохраняя порядок', () => {
    const c = createReceiptClaims();
    c.claim(['a']);
    expect(c.claim(['a', 'b', 'a', 'c'])).toEqual(['b', 'c']);
  });

  it('повтор внутри одной пачки не задваивается', () => {
    const c = createReceiptClaims();
    expect(c.claim(['x', 'x', 'x'])).toEqual(['x']);
    expect(c.size()).toBe(1);
  });

  it('отпущенное можно занять снова — сорванная отправка повторится', () => {
    const c = createReceiptClaims();
    const first = c.claim(['a', 'b']);
    c.release(first);
    expect(c.claim(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('отпускается только названное', () => {
    const c = createReceiptClaims();
    c.claim(['a', 'b']);
    c.release(['a']);
    expect(c.claim(['a', 'b'])).toEqual(['a']);
  });

  it('пустое, пробельное и не-строки не занимают места', () => {
    const c = createReceiptClaims();
    expect(c.claim(['', '   ', null, undefined, 42, {}])).toEqual([]);
    expect(c.size()).toBe(0);
  });

  it('пробелы по краям не создают второго идентификатора', () => {
    const c = createReceiptClaims();
    expect(c.claim([' a '])).toEqual(['a']);
    expect(c.claim(['a'])).toEqual([]);
  });

  it('память ограничена: старое вытесняется, новое помнится', () => {
    const c = createReceiptClaims(3);
    c.claim(['a', 'b', 'c', 'd']);
    expect(c.size()).toBe(3);
    // Вытеснено самое старое — отметка на него уйдёт повторно, это безвредно.
    expect(c.claim(['a'])).toEqual(['a']);
    // А недавнее по-прежнему помнится.
    expect(c.claim(['d'])).toEqual([]);
  });

  it('потолок не сползает при многих пачках', () => {
    const c = createReceiptClaims(10);
    for (let i = 0; i < 500; i++) c.claim([`m${i}`]);
    expect(c.size()).toBe(10);
  });

  it('негодный потолок заменяется разумным, а не отключает память', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const c = createReceiptClaims(bad);
      c.claim(['a']);
      expect(c.claim(['a'])).toEqual([]);
    }
  });
});

// ── Проверка не пустая: форма экрана переписки ──────────────────────────────

const SCREEN = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'),
  'utf8'
);

describe('экран переписки шлёт отметки одним способом', () => {
  it('счётчик один на экран', () => {
    expect(SCREEN).toContain('createReceiptClaims()');
    expect(SCREEN).not.toContain('readSentRef');
  });

  it('все три места зовут общую отправку', () => {
    expect(SCREEN).toContain('const sendReadReceiptsFor = useCallback(');
    // Ровно три вызова: список из базы, появление строк, видимая часть.
    expect(SCREEN.split('sendReadReceiptsFor(').length - 1).toBe(3);
  });

  it('поштучная отправка ушла', () => {
    expect(SCREEN).not.toContain('sendReadReceipt(peerB64, m.id)');
  });

  it('отбор по состоянию строки, которое не меняется, убран', () => {
    expect(SCREEN).not.toContain("m.status !== 'read'");
  });

  it('отказ отпускает занятое, а не глушится', () => {
    expect(SCREEN).not.toContain('sendReadReceipt(peerB64, unreadIds).catch(() => {})');
    const claim = SCREEN.indexOf('readClaimsRef.current.claim(ids)');
    const send = SCREEN.indexOf('svc.sendReadReceipt(peerB64, fresh)');
    const release = SCREEN.indexOf('readClaimsRef.current.release(fresh)');
    expect(claim).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(claim);
    expect(release).toBeGreaterThan(send);
  });

  it('сорванная отправка попадает в журнал без текста сообщения', () => {
    expect(SCREEN).toContain("log.warn('chat_read_receipt_failed', { n: fresh.length");
    expect(SCREEN).toContain("log.warn('chat_read_receipt_scan_failed'");
  });
});
