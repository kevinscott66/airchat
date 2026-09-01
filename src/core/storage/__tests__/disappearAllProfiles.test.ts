/**
 * v4.32.444 — рэтчет: исчезающие сообщения исчезают во всех профилях.
 *
 * Дефект: purgeDisappearedMessages принимала id активного профиля, а таймер,
 * который её вызывает, один на приложение и заводится под текущую личность.
 * У второго аккаунта исчезающие сообщения не исчезали вовсе, пока открыт
 * первый: лежали на диске сколько угодно долго и пропадали разом при
 * переключении профиля. Обещание «исчезнет через N минут» не выполнялось тем
 * дольше, чем реже человек заходил во второй аккаунт.
 *
 * Тест исходниковый: у функции нет параметра профиля, оба запроса про таймеры
 * идут по всем строкам, а область удаления каждая строка задаёт сама.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'local.ts');
const APP = path.join(__dirname, '..', '..', '..', 'App.tsx');
const src = fs.readFileSync(SRC, 'utf8');
const app = fs.readFileSync(APP, 'utf8');

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

const HEAD = 'export async function purgeDisappearedMessages(';
const purgeBody = (): string => codeLines(bodyOf(src, HEAD)).join('\n');

describe('чистка исчезающих не сужается до одной личности', () => {
  it('у функции нет параметра профиля', () => {
    expect(src).toContain('export async function purgeDisappearedMessages(): Promise<void> {');
  });

  it('в теле нет ambient-переменной профиля — область берётся из строки', () => {
    expect(purgeBody()).not.toContain('ownerProfileId');
  });

  it('переписки с таймером отбираются по всем профилям', () => {
    const code = purgeBody();
    expect(code).toContain(
      "'SELECT contact_pub_b64, owner_profile_id, disappear_after_ms, disappear_set_at FROM conversations WHERE disappear_after_ms IS NOT NULL AND disappear_after_ms > 0'",
    );
    expect(code).toContain('const disappearScope = [c.contact_pub_b64, c.owner_profile_id,');
    expect(code).toContain('refreshConversationAfterPurge(d, dek, c.contact_pub_b64, c.owner_profile_id)');
  });

  it('группы с таймером отбираются по всем профилям', () => {
    const code = purgeBody();
    expect(code).toContain(
      "'SELECT id, owner_profile_id, disappear_after_ms, disappear_set_at FROM groups WHERE disappear_after_ms IS NOT NULL AND disappear_after_ms > 0'",
    );
    expect(code).toContain('const grpScope = [g.id, g.owner_profile_id,');
    expect(code).toContain('refreshGroupAfterPurge(d, dek, g.id, g.owner_profile_id)');
  });

  it('удаление всё ещё ограничено owner_profile_id самой строки', () => {
    const code = purgeBody();
    const deletes = code.split('\n').filter((l) => l.includes('DELETE FROM'));
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    for (const d of deletes) expect(d).toContain('owner_profile_id = ?');
  });

  it('таймер в App.tsx зовёт чистку без аргумента', () => {
    expect(app).toContain('void purgeDisappearedMessages();');
    expect(app).toContain('setInterval(() => void purgeDisappearedMessages(), 60_000)');
    expect(app).not.toContain('purgeDisappearedMessages(pid)');
  });
});

describe('фикстура до-фиксного кода не проходит рэтчет', () => {
  const PRE_FIX = [
    'export async function purgeDisappearedMessages(ownerProfileId: number): Promise<void> {',
    '  const d = await db();',
    '  const convs = await d.getAllAsync(',
    "    'SELECT contact_pub_b64, disappear_after_ms, disappear_set_at FROM conversations WHERE owner_profile_id = ? AND disappear_after_ms IS NOT NULL AND disappear_after_ms > 0',",
    '    [ownerProfileId]',
    '  );',
    '  for (const c of convs) {',
    '    const disappearScope = [c.contact_pub_b64, ownerProfileId, 0, 0];',
    "    await d.runAsync('DELETE FROM chat_messages WHERE contact_pub_b64 = ? AND owner_profile_id = ? AND created_at < ? AND created_at >= ?', disappearScope);",
    '  }',
    '}',
  ].join('\n');

  it('до фикса область бралась из параметра, а не из строки', () => {
    const code = codeLines(bodyOf(PRE_FIX, HEAD)).join('\n');
    expect(code).toContain('ownerProfileId');
    expect(code).not.toContain('c.owner_profile_id');
    expect(code).toContain('WHERE owner_profile_id = ? AND disappear_after_ms IS NOT NULL');
  });
});
