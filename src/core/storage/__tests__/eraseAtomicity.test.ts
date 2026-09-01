/**
 * v4.32.443 — рэтчет: стирание истории целиком или никак.
 *
 * Дефект: «очистить историю», «очистить всю историю», «очистить сообщения
 * группы» и «выйти из группы» выполняли по четыре-шесть DELETE подряд без
 * транзакции. Сбой посередине (блокировка базы, нет места, битая строка,
 * убийство процесса на Android) фиксировал уже выполненные DELETE и оставлял
 * остальной шифротекст на диске. У выхода из группы строка `groups`
 * удалялась первой, поэтому пережившая сбой переписка становилась
 * недостижимой из интерфейса — стереть её было уже нечем.
 *
 * Тест исходниковый: все четыре стирания обязаны идти через eraseAtomically,
 * его тело обязано фиксировать COMMIT и откатывать ROLLBACK, а снос файлов
 * из кэша — случаться только после фиксации строк.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'local.ts');
const src = fs.readFileSync(SRC, 'utf8');

/** Тело объявления: от строки заголовка до первой закрывающей `}` в 0-й колонке. */
function bodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  // Не expect(): помощник зовётся из тел тестов, и «объявления нет» должно
  // падать как обычная проверка, а не рушить сбор набора.
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

const ERASERS = [
  ['export async function deleteGroup(', 'delete_group'],
  ['export async function clearChatHistory(', 'clear_chat_history'],
  ['export async function clearGroupMessages(', 'clear_group_messages'],
  ['export async function clearAllMessageHistory(', 'clear_all_message_history'],
] as const;

describe('eraseAtomically — единственный дом транзакции стирания', () => {
  const helperBody = (): string[] => codeLines(bodyOf(src, 'async function eraseAtomically('));

  it('снос файлов из кэша — обязательный аргумент, а не опциональный', () => {
    expect(src).toContain('  files: () => Promise<void>\n');
    expect(src).not.toContain('files?: () => Promise<void>');
  });

  it('строки стираются между BEGIN IMMEDIATE и COMMIT', () => {
    const body = helperBody();
    const begin = body.findIndex((l) => l.includes("execAsync('BEGIN IMMEDIATE')"));
    const rows = body.findIndex((l) => l.includes('await rows();'));
    const commit = body.findIndex((l) => l.includes("execAsync('COMMIT')"));
    expect(begin).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(rows);
  });

  it('сбой откатывается и пробрасывается наверх', () => {
    const body = helperBody();
    const rollback = body.findIndex((l) => l.includes("execAsync('ROLLBACK')"));
    const thrown = body.findIndex((l) => l === 'throw e;');
    expect(rollback).toBeGreaterThan(-1);
    expect(thrown).toBeGreaterThan(rollback);
  });

  it('файлы сносятся только после COMMIT и после ROLLBACK-ветки', () => {
    const body = helperBody();
    const commit = body.findIndex((l) => l.includes("execAsync('COMMIT')"));
    const rollback = body.findIndex((l) => l.includes("execAsync('ROLLBACK')"));
    const files = body.findIndex((l) => l === 'await files();');
    expect(files).toBeGreaterThan(commit);
    expect(files).toBeGreaterThan(rollback);
  });
});

describe('все четыре стирания идут через транзакцию', () => {
  for (const [head, label] of ERASERS) {
    const eraserBody = (): string[] => codeLines(bodyOf(src, head));

    it(`${label}: вызывает eraseAtomically со своей меткой`, () => {
      const joined = eraserBody().join('\n');
      expect(joined).toContain('eraseAtomically(');
      expect(joined).toContain(`'${label}',`);
    });

    it(`${label}: не открывает транзакцию в обход помощника`, () => {
      const joined = eraserBody().join('\n');
      expect(joined).not.toContain('BEGIN IMMEDIATE');
      expect(joined).not.toContain('withTransactionAsync');
    });

    it(`${label}: ни один DELETE не стоит раньше eraseAtomically`, () => {
      const body = eraserBody();
      const erase = body.findIndex((l) => l.includes('eraseAtomically('));
      const firstDelete = body.findIndex((l) => l.includes('DELETE FROM'));
      const artifacts = body.findIndex((l) => l.includes('deletePollArtifactsBySelect('));
      const kvBin = body.findIndex((l) => l.includes('kvDelete'));
      expect(erase).toBeGreaterThan(-1);
      for (const idx of [firstDelete, artifacts, kvBin]) {
        if (idx > -1) expect(idx).toBeGreaterThan(erase);
      }
    });

    it(`${label}: кэш вложений сносится после стирания строк`, () => {
      const body = eraserBody();
      const erase = body.findIndex((l) => l.includes('eraseAtomically('));
      const drop = body.findIndex((l) => l.includes('dropOrphanBlobCache('));
      expect(drop).toBeGreaterThan(erase);
      const lastDelete = body.map((l) => l.includes('DELETE FROM')).lastIndexOf(true);
      expect(drop).toBeGreaterThan(lastDelete);
    });
  }
});

describe('фикстура до-фиксного кода не проходит рэтчет', () => {
  const PRE_FIX = [
    'export async function deleteGroup(id: string, ownerProfileId: number): Promise<void> {',
    '  const d = await db();',
    '  const dek = await getOrCreateDataEncryptionKey();',
    '  const doomed = newAttachmentRefs();',
    "  await d.runAsync('DELETE FROM groups WHERE id = ?', [id]);",
    "  await d.runAsync('DELETE FROM group_members WHERE group_id = ?', [id]);",
    "  await d.runAsync('DELETE FROM group_messages WHERE group_id = ?', [id]);",
    '  await dropOrphanBlobCache(d, dek, doomed);',
    '  emitChatWrites();',
    '}',
  ].join('\n');

  it('до фикса DELETE шли подряд и без транзакции', () => {
    const body = codeLines(bodyOf(PRE_FIX, 'export async function deleteGroup('));
    expect(body.join('\n')).not.toContain('eraseAtomically(');
    const firstDelete = body.findIndex((l) => l.includes('DELETE FROM'));
    expect(firstDelete).toBeGreaterThan(-1);
  });
});
