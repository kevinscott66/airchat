/**
 * v4.32.442 — рэтчет: «заглушено сейчас» = muted + непросроченный muted_until.
 *
 * Дефект: `getTotalUnreadCount` / `getTotalGroupUnreadCount` фильтровали по
 * сырой колонке `muted = 0`, игнорируя `muted_until`. После истечения snooze
 * («Беззвучно на час») строка остаётся с `muted = 1`, поэтому непрочитанные
 * такого чата навсегда выпадали из бейджа приложения — при том что список
 * диалогов уже считал чат незаглушённым (там правило применялось целиком) и
 * пуши по нему уже приходили. Бейдж «чинился» только явным «Включить звук».
 *
 * Тест исходниковый: правило про `muted_until` должно существовать в файле
 * ровно в двух местах (`NOT_MUTED_SQL` и `isEffectivelyMuted`), а оба
 * счётчика бейджа обязаны подставлять фрагмент и передавать `now` параметром.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'local.ts');
const src = fs.readFileSync(SRC, 'utf8');

/** Тело объявления: от строки заголовка до первой закрывающей `}` в 0-й колонке. */
function bodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThan(-1);
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

describe('правило «заглушено сейчас» имеет ровно один дом', () => {
  it('SQL-фрагмент существует и учитывает muted_until', () => {
    const m = src.match(/const NOT_MUTED_SQL = '([^']+)';/);
    expect(m).not.toBeNull();
    const frag = (m as RegExpMatchArray)[1];
    expect(frag).toContain('muted = 1');
    expect(frag).toContain('muted_until IS NULL');
    expect(frag).toContain('muted_until > ?');
    expect(frag.startsWith('(NOT ')).toBe(true);
  });

  it('JS-предикат существует и требует now явным аргументом', () => {
    expect(src).toContain(
      'function isEffectivelyMuted(muted: number, mutedUntil: number | null, now: number): boolean',
    );
  });

  it('сравнение с muted_until написано в файле ровно один раз', () => {
    const occurrences = src.split('mutedUntil === null || mutedUntil > now').length - 1;
    expect(occurrences).toBe(1);
    const body = bodyOf(src, 'function isEffectivelyMuted(');
    expect(body).toContain('mutedUntil === null || mutedUntil > now');
  });

  it('предикат используется всеми читателями строк, а не переписывается заново', () => {
    const uses = src.split('isEffectivelyMuted(').length - 1;
    // 1 объявление + listConversations + listArchivedConversations + rowToGroup
    expect(uses).toBeGreaterThanOrEqual(4);
  });
});

describe('счётчики бейджа не фильтруют по сырой колонке muted', () => {
  it('в файле не осталось предиката muted = 0', () => {
    // Комментарии отбрасываем: про сырой `muted = 0` можно писать в доке,
    // нельзя — в коде запроса.
    expect(codeLines(src).join('\n')).not.toContain('muted = 0');
  });

  for (const [head, table] of [
    ['export async function getTotalUnreadCount(', 'conversations'],
    ['export async function getTotalGroupUnreadCount(', 'groups'],
  ] as const) {
    it(`${table}: запрос подставляет NOT_MUTED_SQL и передаёт now`, () => {
      const code = codeLines(bodyOf(src, head)).join('\n');
      expect(code).toContain(`FROM ${table} WHERE owner_profile_id = ? AND \${NOT_MUTED_SQL}`);
      expect(code).toContain('[ownerProfileId, Date.now()]');
      // Параметр now идёт после owner_profile_id — порядок плейсхолдеров в SQL.
      const sqlIdx = code.indexOf('${NOT_MUTED_SQL}');
      const paramsIdx = code.indexOf('[ownerProfileId, Date.now()]');
      expect(sqlIdx).toBeGreaterThan(-1);
      expect(paramsIdx).toBeGreaterThan(sqlIdx);
    });
  }
});

describe('фикстура до-фиксного кода не проходит рэтчет', () => {
  const PRE_FIX = [
    'export async function getTotalUnreadCount(ownerProfileId: number): Promise<number> {',
    '  try {',
    '    const d = await db();',
    '    const r = await d.getFirstAsync<{ n: number }>(',
    "      'SELECT SUM(unread_count) as n FROM conversations WHERE owner_profile_id = ? AND muted = 0',",
    '      [ownerProfileId]',
    '    );',
    '    return r?.n ?? 0;',
    '  } catch (e) {',
    '    return 0;',
    '  }',
    '}',
  ].join('\n');

  it('до фикса запрос содержал сырой muted = 0 и не передавал now', () => {
    const code = codeLines(bodyOf(PRE_FIX, 'export async function getTotalUnreadCount(')).join('\n');
    expect(code).toContain('muted = 0');
    expect(code).not.toContain('${NOT_MUTED_SQL}');
    expect(code).not.toContain('Date.now()');
  });
});
