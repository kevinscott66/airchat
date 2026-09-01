/**
 * Рэтчет v4.32.447: реакция знает, разослана она или осталась только у автора.
 *
 * Что ломалось. toggleAndSyncReaction возвращал `boolean | null`, где:
 *   • `null` значил сразу четыре разных отказа — личность не готова, роль в
 *     группе запрещает, собеседник не определён, строки сообщения нет — и ни
 *     об одном из них человеку сказать было нечего;
 *   • `true`/`false` значили «реакция теперь стоит/снята» независимо от того,
 *     ушёл ли конверт. Если сервиса отправки в этот момент не было, реакция
 *     оставалась только в своей БД: очереди повторной отправки у служебного
 *     конверта нет, значит остальные не увидят её никогда.
 * Экран группы, чтобы хоть отказ по роли проговорить, держал собственную копию
 * проверки — и считал её от состояния экрана, а не от базы.
 *
 * Проверяем текст исходника: важно, что ни один выход не может промолчать.
 */
import * as fs from 'fs';
import * as path from 'path';

const SYNC = path.join(__dirname, '..', 'reactionSync.ts');
const GROUPS = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'GroupsScreen.tsx');
const CHAT = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx');

const src = fs.readFileSync(SYNC, 'utf8');
const groupsSrc = fs.readFileSync(GROUPS, 'utf8');
const chatSrc = fs.readFileSync(CHAT, 'utf8');

/** Тело функции: от строки объявления до первой закрывающей скобки в нулевой колонке. */
function bodyOf(source: string, head: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) return '';
  return lines.slice(start, end + 1).join('\n');
}

/** Строки без комментариев — чтобы запреты не срабатывали на пояснениях. */
function codeLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

const toggleBody = (): string => bodyOf(src, 'export async function toggleAndSyncReaction(');

describe('v4.32.447 — итог реакции обязан быть назван', () => {
  it('ReactionResult — размеченное объединение, отказ всегда с причиной', () => {
    expect(src).toContain('export type ReactionResult =');
    expect(src).toContain('| { ok: false; reason: string }');
    expect(src).toContain('| { ok: true; on: boolean; warning: string | null };');
    // warning обязателен: необязательное поле снова позволило бы «не заметить»
    // конверт, который никуда не ушёл.
    expect(src).not.toContain('warning?:');
    expect(src).toContain('}): Promise<ReactionResult> {');
    expect(src).not.toContain('Promise<boolean | null>');
  });

  it('ни один выход не возвращает безмолвный null', () => {
    const b = toggleBody();
    expect(b).not.toBe('');
    const mute = codeLines(b).filter((l) => l.trim() === 'return null;');
    expect(mute).toEqual([]);
  });

  it('каждый из четырёх отказов несёт свой текст', () => {
    const b = toggleBody();
    expect(b).toContain("return { ok: false, reason: 'Профиль ещё не готов — попробуйте ещё раз через секунду' };");
    expect(b).toContain('return { ok: false, reason: verdict.reason };');
    expect(b).toContain("return { ok: false, reason: 'Не удалось привязать реакцию: собеседник не определён' };");
    // v4.32.599: четвёртый отказ больше не один текст на четыре причины —
    // запись сама называет причину, а текст к ней подбирает reactionWrite.
    expect(b).toContain('return { ok: false, reason: reactionWriteFailureText(res.reason) };');
  });

  it('роль проверяется до записи в свою БД', () => {
    const b = toggleBody();
    const verdict = b.indexOf('canInteractInGroup(roleOf(members, actorKey))');
    const write = b.indexOf('await toggleReaction(');
    expect(verdict).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(verdict).toBeLessThan(write);
  });
});

describe('v4.32.447 — рассылка реакции идёт общей воронкой', () => {
  it('своей копии отправки у реакций не осталось', () => {
    const code = codeLines(src).join('\n');
    expect(code).not.toContain('getMessagingService');
    expect(code).not.toContain('sendMessage(');
    expect(code).not.toContain('Promise.allSettled');
    // И своего понимания «кому слать» тоже: фильтр забаненных был третьей копией.
    expect(code).not.toContain("m.role !== 'banned'");
    expect(code).toContain('activeRecipients(members, actorKey)');
  });

  it('успех несёт предупреждение ровно тогда, когда конверт не ушёл', () => {
    const b = toggleBody();
    expect(b).toContain("const delivery = await fanoutControlEnvelope(");
    expect(b).toContain('warning: delivery.sent');
    expect(b).toContain('? null');
    expect(b).toContain(
      ": undeliveredText(on ? 'Реакция поставлена у вас' : 'Реакция снята у вас', delivery.reason),"
    );
    // Успех — ниже рассылки: иначе снова получится «ok» до всякой отправки.
    expect(b.indexOf('const delivery =')).toBeLessThan(b.indexOf('ok: true,'));
  });

  it('личная реакция уходит собеседнику из scope, а не из параметров', () => {
    const b = toggleBody();
    expect(b).toContain("{ kind: 'dm', peerPubB64: scope.contactPubB64 }");
  });
});

describe('v4.32.447 — экраны проговаривают и отказ, и неразосланный конверт', () => {
  it('группа: своя копия проверки роли убрана, отказ берётся один', () => {
    expect(groupsSrc).toContain('const res = await toggleAndSyncReaction({ msgId: msg.id, emoji, groupId: group.id });');
    expect(groupsSrc).toContain('if (res.warning) showError(res.warning);');
    // Копия читала myRole из состояния экрана и отставала от базы.
    expect(groupsSrc).not.toContain('const verdict = canInteractInGroup(myRole);');
    expect(groupsSrc).not.toContain('canInteractInGroup');
  });

  it('личка: отказ и предупреждение показываются, недавние эмодзи — только по on', () => {
    expect(chatSrc).toContain('if (res.warning) showError(res.warning);');
    expect(chatSrc).toContain('if (res.on) void addRecentReaction(emoji);');
    expect(chatSrc).not.toContain('.then((on) => {\n        if (on) void addRecentReaction(emoji);');
  });
});

describe('v4.32.447 — код до правки этот рэтчет не проходит', () => {
  const BEFORE = [
    'const svc = getMessagingService();',
    'if (!svc) {',
    "  log.warn('reaction_no_service');",
    '  return on;',
    '}',
    '',
    'if (scope.group) {',
    '  const recipients = members',
    "    .filter((m) => m.peerPubB64 !== actorKey && m.role !== 'banned')",
    '    .map((m) => m.peerPubB64);',
    '  return on;',
    '}',
    'return on;',
  ].join('\n');

  it('старая ветка возвращала новое состояние, ничего не отправив', () => {
    expect(BEFORE.split('return on;').length - 1).toBe(3);
    expect(BEFORE).not.toContain('warning');
    expect(BEFORE).not.toContain('fanoutControlEnvelope(');
  });

  it('фильтр получателей был третьей копией одного правила', () => {
    expect(BEFORE).toContain("m.role !== 'banned'");
    expect(BEFORE).not.toContain('activeRecipients(');
  });
});
