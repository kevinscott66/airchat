/**
 * v4.32.445 — рэтчет: «нечем отправить» ≠ «попытались и не вышло».
 *
 * Дефект: в runSyncIfOnline исход строки очереди был булевым. Ветка
 * `const svc = getMessagingService(); if (svc) delivered = await …` при
 * отсутствующем сервисе оставляла delivered = false, и строка получала
 * +1 к attempts. Сервиса нет во вполне обычные моменты — загрузка приложения,
 * только что переключённый профиль, dispose перед пересозданием. Двадцать
 * таких тиков (OUTBOX_MAX_ATTEMPTS) — и сообщение, которое ни разу никто не
 * пытался отправить, навсегда переставало выдаваться outboxDrain, а через
 * семь дней удалялось по TTL. В переписке оно оставалось «отправленным».
 *
 * Тест исходниковый: исход — размеченное объединение, ветка «нет сервиса»
 * обязана быть deferred, и deferred обязан НЕ трогать attempts.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'sync.ts');
const src = fs.readFileSync(SRC, 'utf8');

/** Тело объявления: от строки заголовка до первой закрывающей `}` в 0-й колонке. */
function bodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  if (start < 0) return '';
  const lines = source.slice(start).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (i > 0 && lines[i] === '}') break;
  }
  return out.join('\n');
}

/** Строки без комментариев — чтобы док-комментарии не считались кодом. */
function codeLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

const syncBody = (): string[] => codeLines(bodyOf(src, 'export async function runSyncIfOnline('));

describe('исход строки очереди — размеченное объединение', () => {
  it('тип перечисляет ровно три исхода и требует причину у deferred', () => {
    expect(src).toContain("  | { kind: 'delivered' }");
    expect(src).toContain("  | { kind: 'failed' }");
    expect(src).toContain("  | { kind: 'deferred'; reason: string };");
  });

  it('булева переменная delivered больше не существует', () => {
    expect(syncBody().join('\n')).not.toContain('let delivered');
  });

  it('исход не имеет молчаливого значения по умолчанию', () => {
    const code = syncBody();
    expect(code).toContain('let outcome: ItemOutcome | null = null;');
    const declared = code.findIndex((l) => l.includes('let outcome: ItemOutcome | null = null;'));
    const fallback = code.findIndex((l) => l === 'if (outcome === null) {');
    expect(declared).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(declared);
  });
});

describe('отсутствие messaging-сервиса не тратит попытку', () => {
  it('обе ветки повтора отправки отвечают deferred, а не failed', () => {
    const code = syncBody().join('\n');
    // v4.32.470: обе ветки (dm и ctl) спрашивают службу через serviceForItem,
    // и его отказ — любой, включая «сервиса нет» — переносится в исход как есть.
    expect(code.split('const service = await serviceForItem(item);').length - 1).toBe(2);
    expect(code.split("if (service.kind === 'deferred') {\noutcome = service;").length - 1).toBe(2);
    expect(code).not.toContain('if (svc) delivered');
    const helper = codeLines(bodyOf(src, 'async function serviceForItem(')).join('\n');
    expect(helper).toContain("if (!svc) return { kind: 'deferred', reason: 'no_messaging_service' };");
    expect(helper).not.toContain("kind: 'failed'");
  });

  it('deferred не инкрементирует attempts', () => {
    const code = syncBody();
    const deferredBranch = code.findIndex((l) => l === "} else if (outcome.kind === 'deferred') {");
    const failedBranch = code.findIndex((l, i) => i > deferredBranch && l === '} else {');
    const increment = code.findIndex((l) => l.includes('outboxIncrementAttempts(item.id)'));
    expect(deferredBranch).toBeGreaterThan(-1);
    expect(failedBranch).toBeGreaterThan(deferredBranch);
    // Инкремент лежит в ветке failed, то есть после начала ветки deferred.
    expect(increment).toBeGreaterThan(failedBranch);
    const between = code.slice(deferredBranch, failedBranch).join('\n');
    expect(between).not.toContain('outboxIncrementAttempts');
    expect(between).toContain("log.info('outbox_deferred'");
  });

  it('успех по-прежнему удаляет строку и считается отправленным', () => {
    const code = syncBody();
    const ok = code.findIndex((l) => l === "if (outcome.kind === 'delivered') {");
    const del = code.findIndex((l, i) => i > ok && l.includes('outboxDeleteById(item.id)'));
    const sent = code.findIndex((l, i) => i > del && l === 'sent += 1;');
    expect(ok).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(ok);
    expect(sent).toBeGreaterThan(del);
  });
});

describe('фикстура до-фиксного кода не проходит рэтчет', () => {
  const PRE_FIX = [
    'export async function runSyncIfOnline(): Promise<void> {',
    '  for (const item of batch) {',
    '    let delivered = false;',
    '    const svc = getMessagingService();',
    '    if (svc) delivered = await svc.retrySendDm(p);',
    '    if (delivered) {',
    '      await outboxDeleteById(item.id);',
    '    } else {',
    '      await outboxIncrementAttempts(item.id);',
    '    }',
    '  }',
    '}',
  ].join('\n');

  it('до фикса отсутствие сервиса было неотличимо от провала отправки', () => {
    const code = codeLines(bodyOf(PRE_FIX, 'export async function runSyncIfOnline(')).join('\n');
    expect(code).toContain('let delivered = false;');
    expect(code).toContain('if (svc) delivered');
    expect(code).not.toContain('deferred');
  });
});
