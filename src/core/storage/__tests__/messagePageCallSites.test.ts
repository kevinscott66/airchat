/**
 * messagePageCallSites — страницы сообщений запрашиваются объектом, не позициями.
 *
 * v4.32.430. `listGroupMessages(group.id, pid, 0, 500)` в GroupsScreen прошёл
 * tsc, потому что limit, offset и ownerProfileId — три числа подряд. Журнал
 * админа спрашивал owner_profile_id = 500 и всегда был пуст; никто этого не
 * замечал, потому что пустой журнал выглядит как «событий не было».
 *
 * Почему ошибку было легко написать — измерено по local.ts: из 79 экспортов,
 * принимающих ownerProfileId, 50 ждут его последним параметром, а 29 — вторым
 * (`setGroupMuted(id, pid, muted)`, `listGroupJoinRequests(groupId, pid, status)`
 * и так далее). Два соглашения в одном файле — и рядом стоящий вызов в том же
 * экране написан по второму из них.
 *
 * Тест сторожит форму вызова, а не количество: любой новый вызов обязан
 * передать объект. Перестановка полей объекта — ошибка компиляции, а не
 * молчаливо пустой список.
 *
 * Главный сторож здесь — сам tsc: объект-параметр превращает перестановку в
 * ошибку типов. Этот тест ловит то, что типы поймать не могут, и одну свою
 * слепую зону закрывает отдельно. Слепая зона такая: при переводе вызовов
 * греп по имени пропустил одиннадцатый вызов, потому что тот импортирован под
 * псевдонимом (`const { listChatMessages: lcm } = await import(...)`) и в
 * тексте выглядит как `lcm(peerB64, 99999, 0, activeProfileId)`. Нашёл его
 * tsc. Поэтому ниже отдельным правилом запрещено переименовывать эти два
 * импорта — иначе регулярка снова окажется слепой.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const HOME = path.join('core', 'storage', 'local.ts');

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function codeLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*'));
}

function relKey(full: string): string {
  return path.relative(SRC, full);
}

const FILES = collect(SRC).map((full) => ({
  key: relKey(full),
  lines: codeLines(fs.readFileSync(full, 'utf8')),
}));

/** Позиционный вызов: сразу за скобкой стоит что угодно, кроме `{`. */
const POSITIONAL = /\blist(?:Chat|Group)Messages\(\s*(?!\{)[^)\s]/;
/** Вызов объектом — то, что теперь единственная законная форма. */
const BY_OBJECT = /\blist(?:All)?(?:Chat|Group)Messages\(\{/;

describe('страницы сообщений — только объектом', () => {
  it('позиционных вызовов не осталось нигде', () => {
    const offenders = FILES.filter((f) => f.key !== HOME)
      .flatMap((f) => f.lines.map((l) => ({ key: f.key, line: l })))
      .filter((x) => POSITIONAL.test(x.line))
      .map((x) => `${x.key}: ${x.line}`);
    expect(offenders).toEqual([]);
  });

  it('вызовы объектом действительно есть — тест не вакуумный', () => {
    const users = FILES.filter((f) => f.key !== HOME)
      .filter((f) => f.lines.some((l) => BY_OBJECT.test(l)))
      .map((f) => f.key)
      .sort();
    expect(users).toEqual([
      path.join('core', 'social', 'messaging.ts'),
      path.join('ui', 'components', 'modals', 'chat', 'ChatContactInfoModal.tsx'),
      path.join('ui', 'components', 'modals', 'chat', 'ChatSharedMediaModal.tsx'),
      path.join('ui', 'components', 'modals', 'groups', 'GroupSharedMediaModal.tsx'),
      path.join('ui', 'screens', 'ChatScreen.tsx'),
      path.join('ui', 'screens', 'GroupsScreen.tsx'),
    ]);
  });

  it('исторические формы ловятся, законные — нет', () => {
    // Ровно та строка, что делала журнал админа пустым.
    expect(POSITIONAL.test('const all = await listGroupMessages(group.id, pid, 0, 500);')).toBe(true);
    // И правильные позиционные — их тоже больше нельзя писать.
    expect(POSITIONAL.test('const msgs = await listGroupMessages(group.id, PAGE_SIZE, 0, pid);')).toBe(true);
    expect(POSITIONAL.test('m.listChatMessages(peerB64, 100, 0, activeProfileId)')).toBe(true);

    expect(POSITIONAL.test('const all = await listGroupMessages({ groupId, limit: 500, offset: 0, ownerProfileId: pid });')).toBe(false);
    expect(POSITIONAL.test('await listChatMessages({ contactPubB64, limit, offset, ownerProfileId: pid });')).toBe(false);
    // Не путать с однокоренными соседями.
    expect(POSITIONAL.test('await searchGroupMessages(group.id, q, pid);')).toBe(false);
    expect(POSITIONAL.test('await clearGroupMessages(groupId, pid);')).toBe(false);
    expect(POSITIONAL.test('await listAllGroupMessagesSomething(a, b);')).toBe(false);
  });

  it('эти два импорта не переименовывают — иначе регулярка слепнет', () => {
    const ALIAS = /\blist(?:Chat|Group)Messages\s*:\s*\w/;
    const offenders = FILES.filter((f) => f.key !== HOME)
      .flatMap((f) => f.lines.map((l) => ({ key: f.key, line: l })))
      .filter((x) => ALIAS.test(x.line))
      .map((x) => `${x.key}: ${x.line}`);
    expect(offenders).toEqual([]);

    // Невакуумность: форма, которая один раз уже спрятала вызов от грепа.
    expect(ALIAS.test("const { listChatMessages: lcm } = await import('../local');")).toBe(true);
    // Обычный импорт и объектный вызов под правило не попадают.
    expect(ALIAS.test("import { listChatMessages } from '../local';")).toBe(false);
    expect(ALIAS.test('await listChatMessages({ contactPubB64, limit, offset, ownerProfileId });')).toBe(false);
  });

  it('журнал админа спрашивает лимит 500 и свой профиль', () => {
    const screen = fs.readFileSync(path.join(SRC, 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');
    const call = codeLines(screen).find((l) => l.includes('listGroupMessages({') && l.includes('limit: 500'));
    expect(call).toBeDefined();
    expect(call).toContain('ownerProfileId: pid');
  });
});
