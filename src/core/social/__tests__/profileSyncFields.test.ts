/**
 * Ратчет: каждое поле профиля, которое едет в конверте, входит и в свёртку
 * версии (v4.32.616).
 *
 * Проверяется текстом, а не поведением, потому что buildEnvelope тянет
 * SQLite, SecureStore и транспорт, а ошибка тут ровно одна и она текстовая:
 * поле добавили в конверт и забыли в versionOf. Последствие тихое — версия
 * совпадает с уже отправленной, рассылка честно пропускает каждый контакт, и
 * новая строка не уезжает никому. Ровно так уже дважды было с бумагой на
 * галочку (v4.32.547) и с привязками (v4.32.575).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'profileSync.ts'), 'utf8');
// Комментарии не считаются: слово в объяснении — не вызов.
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function bodyOf(head: string): string {
  const at = CODE.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const end = CODE.indexOf('\n}', at);
  expect(end).toBeGreaterThan(at);
  return CODE.slice(at, end);
}

const FIELDS = ['name', 'username', 'bio', 'pronouns', 'status', 'badge', 'links'];

describe('profileSync: конверт и свёртка версии знают одни и те же поля', () => {
  const build = bodyOf('async function buildEnvelope(');
  const version = bodyOf('function versionOf(');

  it.each(FIELDS)('поле %s собирается в конверт', (field) => {
    expect(build).toMatch(new RegExp(`\\b${field}\\b`));
  });

  it.each(FIELDS)('поле %s входит в свёртку версии', (field) => {
    // Свёртка — одна строка-шаблон: поле обязано стоять в ней, а не просто
    // числиться в списке параметров функции. Ссылки входят через
    // profileLinksKey(links), поэтому проверяется имя, а не форма подстановки.
    const at = version.indexOf('const src =');
    expect(at).toBeGreaterThan(-1);
    const src = version.slice(at, version.indexOf('\n', at));
    expect(src).toMatch(new RegExp(`\\b${field}\\b`));
  });

  it('проверка «есть ли что рассылать» учитывает все поля конверта', () => {
    // Профиль, в котором заполнены ТОЛЬКО местоимения или ТОЛЬКО статус, —
    // всё ещё профиль, и ранний выход не должен его проглатывать.
    const guard = build.slice(build.indexOf('if (!name'));
    expect(guard.slice(0, guard.indexOf('\n'))).toContain('!pronouns');
    expect(guard.slice(0, guard.indexOf('\n'))).toContain('!status');
  });
});
