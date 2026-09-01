/**
 * Синхронизация выгружала пустоту вместо непрочитанного текста (v4.32.588).
 *
 * Лента уезжает наверх расшифрованной — слой синхронизации шифрует каждую
 * строку заново ключом аккаунта. Столбец, не открывшийся ключом этого
 * устройства, приходил к выгрузке пустой строкой и уезжал с новой ревизией;
 * устройство с исправным ключом принимало её как более свежую и затирало
 * свою читаемую запись. Простой пропуск такой строки не годится: строка,
 * которой в выгрузке нет, а в списке голов есть, получает надгробие.
 */
import fs from 'fs';
import path from 'path';

import { feedCommentIsUnreadable, feedPostIsUnreadable } from '../../social/feedPostGuard';
import { heldEntityCount, presentEntityKeys, pushableEntities } from '../entityHold';

const SYNC = () => fs.readFileSync(path.join(__dirname, '..', 'liveAccountSync.ts'), 'utf8');
const STORAGE = () => fs.readFileSync(path.join(__dirname, '..', '..', 'storage', 'feedStorage.ts'), 'utf8');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('придержанная строка', () => {
  const entities = [
    { key: 'a', hold: false },
    { key: 'b', hold: true },
    { key: 'c' },
  ];

  it('наверх не отправляется', () => {
    expect(pushableEntities(entities).map((e) => e.key)).toEqual(['a', 'c']);
  });

  it('но из набора ключей не исчезает — иначе ей выпишут надгробие', () => {
    const keys = presentEntityKeys(entities, (e) => e.key);
    expect(keys.has('b')).toBe(true);
    expect(keys.size).toBe(3);
  });

  it('считается для журнала', () => {
    expect(heldEntityCount(entities)).toBe(1);
    expect(heldEntityCount([])).toBe(0);
  });

  it('признак придержания берётся у ленты', () => {
    expect(feedPostIsUnreadable({ textUnreadable: true })).toBe(true);
    expect(feedCommentIsUnreadable({ textUnreadable: true })).toBe(true);
    expect(feedCommentIsUnreadable({})).toBe(false);
  });

  it('модуль остаётся чистым: ни сети, ни SQLite', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'entityHold.ts'), 'utf8');
    expect(src.match(/^import .*$/gm)).toBeNull();
  });
});

describe('выгрузка ленты держит непрочитанное у себя', () => {
  it('записи и комментарии помечаются придержанными', () => {
    const body = slice(SYNC(), 'async function collectLocalEntities(', 'async function collectPending(');
    // v4.32.589: правило придержания стало шире показа (нечитаемое имя
    // придерживает строку, но не прячет читаемый текст) и получило своё имя.
    expect(body).toContain('hold: feedPostIsHeldFromSync(row),');
    expect(body).toContain('hold: feedCommentIsHeldFromSync(row),');
  });

  it('ключи считаются по всем строкам, а отправляются не все', () => {
    const body = slice(SYNC(), 'async function collectPending(', '\nasync function');
    expect(body).toContain('const currentKeys = presentEntityKeys(entities, (e) => entityKey(e.entityKind, e.entityId));');
    expect(body).toContain('for (const entity of pushableEntities(entities)) {');
    expect(body).toContain("log.warn('live_sync_entities_held_unreadable', { held });");
    expect(body).not.toContain('currentKeys.add(key);');
  });

  it('снимок для синхронизации читает комментарии состоянием', () => {
    const body = slice(STORAGE(), 'async exportSyncSnapshot(', '\n  async ');
    expect(body).toContain('textUnreadable: unreadableFromCellState(textCell.state),');
    expect(body).not.toContain("text: decryptAtRestString(row.text ?? '', dek),");
  });

  it('показ комментариев читает так же', () => {
    const body = slice(STORAGE(), 'async getComments(', '\n  /**');
    expect(body).toContain('const textCell = readAtRestCell(r.text ?? \'\', dek);');
    expect(body).toContain('textUnreadable: unreadableFromCellState(textCell.state),');
  });
});
