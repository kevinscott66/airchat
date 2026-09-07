/**
 * Синхронизация ленты и номер профиля (v4.32.615).
 *
 * У прохода синхронизации свой номер профиля — тот, с которым его завели.
 * Лента же берёт базу из модульной переменной, которую подменяет
 * `rebindFeedToProfile`. Все остальные виды сущностей (сообщения, беседы,
 * настройки, группы, альбомы) получают `ownerProfileId` параметром, и только
 * лента спрашивала «активный» — то есть уже чужой, если человек переключился,
 * пока проход шёл.
 *
 * Стоило это дорого в обе стороны: входящие записи чужого аккаунта ложились в
 * открытую базу, а выгрузка уезжала на сервер под чужой меткой владельца.
 * Ни то, ни другое не лечится повтором — данные уже перемешаны.
 *
 * Теперь номер идёт параметром, а несовпадение — отказ. Отказ ничего не
 * теряет: курсор не двигается, следующий проход сделает ту же работу уже при
 * верной привязке.
 */
import fs from 'fs';
import path from 'path';

import { storageIsOwn } from '../../identity/ownerProfile';

const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'feedService.ts'), 'utf8');
const SYNC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'sync', 'liveAccountSync.ts'),
  'utf8',
);

/** Тело объявления: от заголовка до первой закрывающей скобки в нулевой колонке. */
function bodyOf(src: string, head: string): string {
  const start = src.indexOf(head);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** Тексты аргументов каждого вызова `name(` — со сбалансированными скобками. */
function callArgs(src: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    let depth = 0;
    for (let j = i + needle.length - 1; j < src.length; j += 1) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push(src.slice(i + needle.length, j));
          break;
        }
      }
    }
  }
  return out;
}

const HOOKS = [
  'exportFeedSyncSnapshot',
  'applyFeedSyncPost',
  'applyFeedSyncComment',
  'applyFeedSyncPostDelete',
  'applyFeedSyncCommentDelete',
] as const;

describe('крючки синхронизации ленты принимают номер профиля', () => {
  for (const hook of HOOKS) {
    it(`${hook}: номер обязателен и уходит в ensureStorage`, () => {
      const body = bodyOf(SERVICE, `export async function ${hook}(`);
      expect(body).toContain('ownerProfileId: number');
      expect(body).toContain('ensureStorage(ownerProfileId)');
      // Ни один из них не должен спрашивать базу «активного» профиля.
      expect(body).not.toContain('ensureStorage()');
    });
  }
});

describe('несовпадение номера — отказ, а не запись мимо', () => {
  const ENSURE = bodyOf(SERVICE, 'async function ensureStorage(');

  it('номер профиля — необязательный параметр', () => {
    expect(ENSURE).toContain('async function ensureStorage(ownerProfileId?: number)');
  });

  it('правило «своё или чужое» то же самое, что у рассылки', () => {
    expect(ENSURE).toContain('storageIsOwn(ownerProfileId ?? null, currentProfileId)');
    expect(ENSURE).toContain("throw new Error('feed_storage_profile_mismatch')");
  });

  it('проверка стоит раньше выдачи базы', () => {
    const check = ENSURE.indexOf('storageIsOwn(ownerProfileId');
    const give = ENSURE.indexOf('return storage;');
    expect(check).toBeGreaterThan(0);
    expect(give).toBeGreaterThan(check);
  });

  it('без номера поведение прежнее — остальные вызовы не задеты', () => {
    expect(storageIsOwn(null, 2)).toBe(true);
    expect(storageIsOwn(1, 2)).toBe(false);
    expect(storageIsOwn(2, 2)).toBe(true);
  });
});

describe('синхронизация передаёт свой номер, а не активный', () => {
  it('выгрузка ленты идёт под номером прохода', () => {
    const collect = bodyOf(SYNC, 'async function collectLocalEntities(');
    expect(collect).toContain('exportFeedSyncSnapshot(ownerProfileId)');
    // Соседние выгрузки давно так и делают — лента была единственным исключением.
    expect(collect).toContain('exportRawChatMessageRows(ownerProfileId)');
  });

  for (const hook of ['applyFeedSyncPost', 'applyFeedSyncComment', 'applyFeedSyncPostDelete', 'applyFeedSyncCommentDelete']) {
    it(`${hook}: номер владельца берётся из самой мутации`, () => {
      const calls = callArgs(SYNC, `await ${hook}`);
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) expect(args).toContain('mutation.ownerProfileId');
    });
  }

  it('ни один вид сущности не применяется без номера владельца', () => {
    const apply = bodyOf(SYNC, 'async function applyPulledMutation(');
    for (const m of apply.matchAll(/await (applyFeedSync\w+|importRawChatMessageRows|applySyncStoryAlbum\w*)\(/g)) {
      const args = callArgs(apply, `await ${m[1]}`);
      for (const a of args) expect(a).toContain('ownerProfileId');
    }
  });
});
