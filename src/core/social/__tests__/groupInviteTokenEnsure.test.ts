import * as fs from 'fs';
import * as path from 'path';

/**
 * Новый токен группы рождается только после успешного чтения (v4.32.437).
 *
 * getGroup отдаёт null и когда такой группы у профиля нет, и когда чтение не
 * удалось — он гасит любую ошибку. ensureGroupInviteToken раньше считал оба
 * случая одинаковыми: «токена нет, значит заводим». Цена ошибки высокая и
 * молчаливая. Новый токен отзывает ВСЕ ранее разосланные ссылки, а
 * администратор об этом не узнаёт: кнопка отдаёт свежую ссылку как ни в чём не
 * бывало. Во втором случае хуже: запись токена уходит в ноль строк, и выданная
 * ссылка не сверяется ни с чем.
 *
 * Тест исходный, а не поведенческий: чтобы завести живой groupMessaging, нужны
 * транспорт, база и ключи — а правило здесь про порядок двух строк.
 */
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'groupMessaging.ts'), 'utf8');

/** Тело функции: от её объявления до строки, закрывающей объявление. */
function bodyOf(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.includes(`export async function ${name}(`));
  if (start < 0) return '';
  let end = start;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

/** Строки тела без комментариев — правило проверяется по коду, а не по прозе. */
function codeLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

describe('ensureGroupInviteToken не крутит токен вслепую', () => {
  const BODY = bodyOf(SOURCE, 'ensureGroupInviteToken');

  it('функция на месте и читает группу', () => {
    expect(BODY).toContain('await getGroup(groupId, ownerProfileId)');
  });

  it('непрочитанная группа отсекается ДО рождения нового токена', () => {
    const code = codeLines(BODY);
    const guard = code.indexOf('if (!fresh) {');
    const rotate = code.findIndex((l) => l.includes('rotateGroupInviteToken('));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(rotate).toBeGreaterThan(guard);
    expect(code.slice(guard, rotate)).toContain('return null;');
  });

  it('отказ виден в ответе: тип допускает null', () => {
    // v4.32.452: ответ вырос до InviteTokenResult — токен вместе с исходом
    // рассылки нового токена другим администраторам. Отказ чтения группы
    // по-прежнему отличим: это null всего ответа, а не пустой токен.
    expect(BODY).toContain('Promise<InviteTokenResult | null>');
    expect(SOURCE).toContain('export type InviteTokenResult = {');
    expect(SOURCE).toContain('announced: GroupControlOutcome | null;');
  });

  it('токен без изменений не выдаёт себя за разосланный', () => {
    expect(BODY).toContain("return { token: fresh.inviteToken, announced: null };");
    const rotate = bodyOf(SOURCE, 'rotateGroupInviteToken');
    // У сброса announced всегда есть: пустой список администраторов воронка
    // считает «разослано нулю», а не отказом.
    expect(rotate).toContain('): Promise<InviteTokenResult> {');
    expect(rotate).toContain('return { token, announced };');
    expect(rotate).not.toContain('if (admins.length) {');
  });

  it('проверка не пустая: прежняя редакция не проходит', () => {
    const before = [
      'export async function ensureGroupInviteToken(',
      '  groupId: string,',
      '  ownerProfileId: number',
      '): Promise<string> {',
      "  const { getGroup } = await import('../storage/local');",
      '  const fresh = await getGroup(groupId, ownerProfileId);',
      '  if (fresh && isInviteToken(fresh.inviteToken)) return fresh.inviteToken;',
      '  return rotateGroupInviteToken(groupId, ownerProfileId, myPubB64, myName);',
      '}',
    ].join('\n');
    const body = bodyOf(before, 'ensureGroupInviteToken');
    expect(body).toContain('await getGroup(groupId, ownerProfileId)');
    expect(codeLines(body).indexOf('if (!fresh) {')).toBe(-1);
    expect(body).not.toContain('Promise<InviteTokenResult | null>');
  });
});

describe('вызывающие обязаны разобрать отказ', () => {
  const SCREEN = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
    'utf8'
  );

  it('все места вызова — в этом одном экране', () => {
    const uses = SOURCE.split('ensureGroupInviteToken').length - 1;
    expect(uses).toBeGreaterThan(0);
    const inScreen = SCREEN.split('await ensureGroupInviteToken(').length - 1;
    expect(inScreen).toBe(3);
  });

  it('ни одно место не строит ссылку, не проверив ответ', () => {
    // Первое — сборщик ссылки, он бросает; два других показывают ошибку.
    expect(SCREEN).toContain("throw new Error('group_invite_token_unavailable');");
    // v4.32.601: текст стал общим для обеих причин отказа (группу не прочитать
    // либо не открылся столбец с токеном); проверяем сам страж, а не старую фразу.
    const guards =
      SCREEN.split("=== null) { showError('Не удалось получить пригласительную ссылку'); return; }")
        .length - 1;
    expect(guards).toBe(2);
  });
});

/**
 * v4.32.452: исход рассылки нового токена дочитан везде.
 *
 * Токен рождается в двух случаях: по кнопке «Сбросить» и при первом нажатии у
 * групп, созданных до v4.32.303. В обоих о нём сообщают другим
 * администраторам — и раньше это сообщение гасилось внутри. У второго
 * администратора оставался прежний токен: его кнопка «Пригласительная ссылка»
 * продолжала выдавать ссылки, которые группа уже не пускает, а отзыв выглядел
 * состоявшимся.
 */
describe('расхождение по токену называется вслух', () => {
  const SCREEN2 = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx'),
    'utf8'
  );
  const ANNOUNCE = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'ui', 'groupControlAnnounce.ts'),
    'utf8'
  );
  const OUTCOME = fs.readFileSync(path.join(__dirname, '..', 'groupControlOutcome.ts'), 'utf8');

  it('фраза про кнопку другого администратора живёт в одном месте', () => {
    expect(OUTCOME).toContain('export function inviteTokenSpreadProblem(outcome: GroupControlOutcome): string | null {');
    expect(OUTCOME).toContain('продолжит выдавать ссылки, которые группа уже не пускает');
    expect(ANNOUNCE).toContain('export function announceInviteToken(announced: GroupControlOutcome | null): boolean {');
  });

  it('все четыре места разбирают исход, а не только токен', () => {
    expect(SCREEN2.split('announceInviteToken(').length - 1).toBe(4);
    expect(SCREEN2).not.toContain('await showInviteSheet(next);');
    expect(SCREEN2).toContain('await showInviteSheet(invite.token);');
    expect(SCREEN2).toContain('token: invite.token,');
  });

  it('«Ссылка сброшена» говорится только когда о ней узнали', () => {
    expect(SCREEN2).toContain('if (!announceInviteToken(next.announced)) {');
    const say = SCREEN2.indexOf("showSuccess('Ссылка сброшена — прежние больше не действуют')");
    const guard = SCREEN2.indexOf('if (!announceInviteToken(next.announced)) {');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(say).toBeGreaterThan(guard);
  });
});
