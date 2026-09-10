/**
 * Рэтчет v4.32.630: беззвучный режим экран показывает по записи, а не по факту
 * нажатия.
 *
 * Обе половины переключателя гасили свой отказ и не отвечали ничего:
 * `setConversationMuted*` ловила исключение в журнал, `setMuted` теряла ответ
 * `scopedKvSet`. Экраны переключали строку меню, шапку чата и значок поста
 * безусловно — то есть показывали не то, что в базе. Тишина обещана,
 * уведомления идут; или наоборот — «Включить звук» там, где muted=1 никуда не
 * делось, и вернуться к рабочему состоянию человеку нечем.
 *
 * Правило простое и потому проверяемое механически: в экранах ответ каждой из
 * этих записей обязан быть прочитан — либо связан именем, либо проверен прямо
 * в условии. `UserProfilePeek.tsx` сюда не входит намеренно: файл помечен
 * @stable и правится только по явной просьбе — расхождение там остаётся и
 * названо в отчёте.
 */
import * as fs from 'fs';
import * as path from 'path';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');

const SCREENS = [
  'screens/ChatScreen.tsx',
  'screens/ChatListScreen.tsx',
  'screens/GroupsScreen.tsx',
  'screens/FeedScreen.tsx',
] as const;

/** Записи беззвучного режима, ответ которых обязателен к прочтению. */
const WRITES = [
  'muteSet(',
  'muteUnset(',
  'setMuted(',
  'unmute(',
  'setConversationMuted(',
  'setConversationMutedUntil(',
];

/** Строки кода без комментариев — пояснение не должно подменять проверку. */
function codeLines(src: string): string[] {
  return src.split('\n').filter((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
}

/** Вызовы записи, чей ответ никуда не идёт. */
function unreadCalls(src: string): string[] {
  return codeLines(src).filter((l) => {
    const call = WRITES.find((w) => l.includes(`await ${w}`));
    if (!call) return false;
    const bound = /\b(const|let)\s+\w+\s*=\s*await\s/.test(l) || l.includes(`!(await ${call}`);
    return !bound;
  }).map((l) => l.trim());
}

describe('ответ записи беззвучного режима прочитан', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: сами вызовы в экранах есть', () => {
    const total = SCREENS.reduce(
      (n, rel) => n + codeLines(read(rel)).filter((l) => WRITES.some((w) => l.includes(`await ${w}`))).length,
      0
    );
    expect(total).toBeGreaterThanOrEqual(8);
  });

  it.each(SCREENS)('%s не выбрасывает ни одного ответа', (rel) => {
    expect(unreadCalls(read(rel))).toEqual([]);
  });

  it('BEFORE: прежний вид того же кода правило ловит', () => {
    const before = [
      "void setConversationMuted(item.contactPubB64, pid, false)",
      "  .then(() => muteUnset('chat', item.contactPubB64))",
      "await setConversationMutedUntil(item.contactPubB64, pid, u);",
      "await muteSet('chat', item.contactPubB64, u !== null ? { untilMs: u } : undefined);",
      "await setMuted('post', postId);",
    ].join('\n');
    expect(unreadCalls(before)).toHaveLength(3);
  });
});

describe('отказ доходит до человека', () => {
  it('список переписок называет обе неудачи', () => {
    const src = read('screens/ChatListScreen.tsx');
    expect(src).toContain("showError('Не удалось включить звук')");
    expect(src).toContain("showError('Не удалось отключить уведомления')");
  });

  it('чат называет обе неудачи и не переключает шапку', () => {
    const src = read('screens/ChatScreen.tsx');
    const at = src.indexOf('const okRow = await setConversationMuted(peerB64');
    expect(at).toBeGreaterThan(0);
    // Отказ уходит раньше, чем шапка успевает показать «звук включён».
    const guard = src.indexOf("showError('Не удалось включить звук'); return;", at);
    const flip = src.indexOf('setIsMuted(false)', at);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(flip);
  });

  it('группы поднимают отказ до своей обёртки с русским текстом', () => {
    const src = read('screens/GroupsScreen.tsx');
    // runGuardedOp/runRowOp показывают fallback: машинный опознаватель до
    // экрана не доходит (см. userErrorText).
    // v4.32.680: было по три — два одинаковых пункта меню (участнику и
    // администратору) плюс команда. Меню слились в одно окно настроек, копия
    // ушла; осталось по два, и оба обязаны быть на месте.
    expect(src.split("throw new Error('mute_unset_failed')").length - 1).toBe(2);
    expect(src.split("throw new Error('mute_set_failed')").length - 1).toBe(2);
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: уцелевшая ветка лежит в обработчике окна, а не в
    // ещё одном списке пунктов, и по-прежнему под runGuardedOp.
    const at = src.indexOf("case 'mute': {");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("case 'auto_translate': {", at));
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("throw new Error('mute_unset_failed')");
    expect(body).toContain("throw new Error('mute_set_failed')");
    expect(body).toContain("runGuardedOp(");
  });

  it('лента не переключает значок поста без записи', () => {
    const src = read('screens/FeedScreen.tsx');
    const at = src.indexOf("const currently = await isMuted('post', postId);");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 1200);
    expect(block).toContain("showError('Не удалось включить уведомления'); return;");
    expect(block).toContain("showError('Не удалось отключить уведомления'); return;");
  });
});
