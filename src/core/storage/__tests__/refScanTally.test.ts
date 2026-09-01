/**
 * Уборка кэша вложений и строки, которые не открылись.
 *
 * Список живых ссылок собирался расшифровкой каждой строки через
 * decryptAtRestString, а тот на неудаче отдаёт пустую строку. Из неё не
 * вынимается ни одного имени файла — то есть непрочитанная строка молча
 * заявляла, что ни на какие вложения не ссылается, и её фотография тут же
 * объявлялась сиротой и стиралась. При разошедшемся ключе данных нечитаемой
 * становится вся история сразу, и уборка сносила весь кэш целиком.
 */

import fs from 'fs';
import path from 'path';
import {
  countScannedCell,
  countScannedRow,
  emptyRefScanTally,
  mayDeleteUnreferenced,
  mergeRefScanTally,
  refScanIsComplete,
  refScanReport,
} from '../refScanTally';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const LOCAL = (): string => read('core/storage/local.ts');
const MEDIA_BLOB = (): string => read('core/media/mediaBlob.ts');

function bodyOf(src: string, head: string): string {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end === -1 ? rest.length : end);
}

describe('счёт обхода', () => {
  it('пустой обход полон: нечего читать — нечему и не прочитаться', () => {
    const t = emptyRefScanTally();
    expect(refScanIsComplete(t)).toBe(true);
    expect(mayDeleteUnreferenced(t)).toBe(true);
    expect(refScanReport(t)).toEqual({ rows: 0, unreadable: 0 });
  });

  it('прочитанные и отсутствующие ячейки полноты не портят', () => {
    const t = emptyRefScanTally();
    for (let i = 0; i < 5; i++) {
      countScannedRow(t);
      countScannedCell(t, 'plain');
      countScannedCell(t, 'absent');
    }
    expect(t.rows).toBe(5);
    expect(t.unreadableCells).toBe(0);
    expect(mayDeleteUnreferenced(t)).toBe(true);
  });

  it('одной непрочитанной ячейки хватает, чтобы запретить удаление', () => {
    const t = emptyRefScanTally();
    for (let i = 0; i < 999; i++) {
      countScannedRow(t);
      countScannedCell(t, 'plain');
    }
    countScannedRow(t);
    countScannedCell(t, 'unreadable');
    expect(refScanIsComplete(t)).toBe(false);
    expect(mayDeleteUnreferenced(t)).toBe(false);
    expect(refScanReport(t)).toEqual({ rows: 1000, unreadable: 1 });
  });

  it('обходы таблиц складываются, и неполнота одной портит общий', () => {
    const all = emptyRefScanTally();
    const good = emptyRefScanTally();
    countScannedRow(good);
    countScannedCell(good, 'plain');
    const bad = emptyRefScanTally();
    countScannedRow(bad);
    countScannedCell(bad, 'unreadable');
    mergeRefScanTally(all, good);
    expect(mayDeleteUnreferenced(all)).toBe(true);
    mergeRefScanTally(all, bad);
    expect(mayDeleteUnreferenced(all)).toBe(false);
    expect(all.rows).toBe(2);
  });

  it('разошедшийся ключ данных: не читается ничего — не удаляется ничего', () => {
    // Именно этот случай стирал весь кэш вложений разом.
    const t = emptyRefScanTally();
    for (let i = 0; i < 400; i++) {
      countScannedRow(t);
      countScannedCell(t, 'unreadable');
      countScannedCell(t, 'unreadable');
    }
    expect(mayDeleteUnreferenced(t)).toBe(false);
    expect(refScanReport(t).unreadable).toBe(800);
  });
});

describe('форма исходников', () => {
  it('обход ссылок читает состоянием ячейки, а не строкой', () => {
    const b = bodyOf(LOCAL(), 'async function collectAttachmentRefs(');
    expect(b).toContain('readAtRestCell(r.text ?? null, dek)');
    expect(b).toContain('readAtRestCell(r.media_cids ?? null, dek)');
    expect(b).toContain('countScannedRow(into.scan);');
    expect(b).toContain('countScannedCell(into.scan, textCell.state);');
    expect(b).toContain('countScannedCell(into.scan, cidsCell.state);');
    // Источник склейки «не прочиталось» и «пусто» здесь больше не зовётся.
    expect(b).not.toContain('decryptAtRestString(r.text');
    expect(b).not.toContain('decryptAtRestString(r.media_cids');
  });

  it('счёт едет вместе со ссылками, а не рядом с ними', () => {
    const l = LOCAL();
    expect(l).toContain('scan: RefScanTally;');
    expect(l).toContain('return { ids: new Set<string>(), uris: new Set<string>(), scan: emptyRefScanTally() };');
  });

  it('суточная уборка получает отказ, а не короткий список', () => {
    const b = bodyOf(LOCAL(), 'export async function liveAttachmentBlobIds(');
    expect(b).toContain('if (!mayDeleteUnreferenced(alive.scan)) {');
    expect(b).toContain('throw new Error(');
    expect(b).toContain('ref_scan_incomplete');
    expect(b).not.toContain('return (await liveAttachmentRefs()).ids;');
  });

  it('уборка вслед за удалёнными сообщениями останавливается там же', () => {
    const b = bodyOf(LOCAL(), 'async function dropOrphanBlobCache(');
    expect(b).toContain('if (!mayDeleteUnreferenced(alive.scan)) {');
    expect(b).toContain("log.warn('blob_cache_sweep_skipped_incomplete', refScanReport(alive.scan));");
    // Запрет обязан стоять ДО того, как посчитано, что стирать.
    expect(b.indexOf('mayDeleteUnreferenced(')).toBeLessThan(b.indexOf('idsToDelete'));
  });

  it('осторожность самой уборки на месте: без списка живых ссылок не стирает', () => {
    const b = bodyOf(MEDIA_BLOB(), 'export async function sweepMediaCache(');
    expect(b).toContain('let liveIds: ReadonlySet<string> | null = null;');
    expect(b).toContain("log.warn('media_cache_live_refs_failed'");
    // Ключ к правке: брошенное отсюда исключение оставляет liveIds равным
    // null, а null останавливает удаление целиком.
    expect(b).toContain('liveIds = await loadLiveIds();');
  });
});
