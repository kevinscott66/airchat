/**
 * Уборка снимков истёкших сторис не должна опустошать соседний профиль.
 *
 * Дефект (v4.32.615). Список «ещё живых» адресов собирался запросом с
 * `WHERE owner_profile_id = ?`, хотя кэш расшифрованных снимков один на
 * приложение, а имя файла определяется самим вложением. Одна и та же сторис
 * общего контакта в двух профилях — это один файл на диске. Истекала она в
 * первом профиле — уборка второго не видела, объявляла файл сиротой и стирала
 * его: у второго профиля живая сторис становилась чёрным прямоугольником.
 *
 * Ровно об этом говорит комментарий у ATTACHMENT_REF_SOURCES: «Условия WHERE
 * нет намеренно: кэш один на приложение, а профилей на нём несколько».
 *
 * Проверка поведенческая: запрос берётся прямо из local.ts и выполняется на
 * настоящем SQLite поверх таблицы stories, а его результат отдаётся в тот же
 * planStoryMediaSweep, что и в приложении.
 */
import { readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

import { planStoryMediaSweep, type StoryUriCell } from '../../media/storyMediaSweep';

const SRC = readFileSync(join(__dirname, '..', 'local.ts'), 'utf8');

/** Запрос «ещё живых» адресов из тела dropStoryMediaFiles. */
function aliveQuery(): string {
  const at = SRC.indexOf('async function dropStoryMediaFiles(');
  expect(at).toBeGreaterThanOrEqual(0);
  const start = SRC.indexOf("'SELECT media_uri FROM stories", at);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf("'", start + 1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start + 1, end);
}

/** Общий снимок: одна сторис контакта, принятая в двух профилях. */
const SHARED = 'file:///cache/airchat_media_abc.jpg';

function freshDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE stories (
      id TEXT NOT NULL,
      author_pub_b64 TEXT NOT NULL,
      media_uri TEXT,
      expires_at INTEGER NOT NULL,
      owner_profile_id INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (id, owner_profile_id)
    );
  `);
  // Истёкшая — в первом профиле; живая с тем же файлом — во втором.
  d.exec(`INSERT INTO stories VALUES ('s1', 'peerA', '${SHARED}', 1000, 1);`);
  d.exec(`INSERT INTO stories VALUES ('s1', 'peerA', '${SHARED}', 9000000000000, 2);`);
  return d;
}

/** Уборка идёт после DELETE — истёкшей строки в таблице уже нет. */
function afterExpiryDelete(d: DatabaseSync): void {
  d.prepare('DELETE FROM stories WHERE expires_at < ? AND owner_profile_id = ?').run(2000, 1);
}

function aliveCells(d: DatabaseSync, sql: string, params: unknown[] = []): StoryUriCell[] {
  const rows = d.prepare(sql).all(...(params as never[])) as unknown as { media_uri: string | null }[];
  return rows.map((r) => ({ state: r.media_uri ? 'plain' : 'absent', uri: r.media_uri }));
}

describe('уборка снимков сторис: кэш общий для всех профилей', () => {
  it('запрос живых адресов не сужен до одного профиля', () => {
    expect(aliveQuery()).toBe('SELECT media_uri FROM stories');
  });

  it('файл, нужный соседнему профилю, остаётся на диске', () => {
    const d = freshDb();
    afterExpiryDelete(d);
    const plan = planStoryMediaSweep([SHARED], aliveCells(d, aliveQuery()));
    expect(plan.blocked).toBe(false);
    expect(plan.deletable).toEqual([]);
    d.close();
  });

  it('прежний запрос стирал его — таков был дефект', () => {
    const d = freshDb();
    afterExpiryDelete(d);
    const prior = planStoryMediaSweep(
      [SHARED],
      aliveCells(d, 'SELECT media_uri FROM stories WHERE owner_profile_id = ?', [1]),
    );
    expect(prior.deletable).toEqual([SHARED]);
    d.close();
  });

  it('на файл никто больше не ссылается — стираем', () => {
    const d = freshDb();
    d.prepare('DELETE FROM stories WHERE owner_profile_id = ?').run(2);
    afterExpiryDelete(d);
    const plan = planStoryMediaSweep([SHARED], aliveCells(d, aliveQuery()));
    expect(plan.deletable).toEqual([SHARED]);
    d.close();
  });

  it('свой снимок во втором профиле тоже держит файл', () => {
    const d = freshDb();
    d.prepare('UPDATE stories SET author_pub_b64 = ? WHERE owner_profile_id = ?').run('self', 2);
    afterExpiryDelete(d);
    expect(planStoryMediaSweep([SHARED], aliveCells(d, aliveQuery())).deletable).toEqual([]);
    d.close();
  });
});
