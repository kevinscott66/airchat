/**
 * Рэтчет v4.32.448: «собеседник не узнал про таймер» больше не молчит.
 *
 * Что ломалось. setDisappearAndSync ставил таймер у себя, писал системную
 * строку в переписку и пытался отправить конверт. Если сервиса отправки не
 * было, функция просто выходила: возвращаемого значения у неё не было вовсе.
 * Экран показывал новое значение таймера, а модалка над кнопкой обещает
 * дословно — «Выбранное время действует у обоих собеседников». У себя
 * сообщения исчезают, у собеседника лежат вечно, и узнать об этом неоткуда.
 * Повторной отправки у служебного конверта нет: «не ушло» значит «не уйдёт».
 *
 * Для приватной переписки это не косметика — человек пишет, считая, что
 * сказанное сотрётся с обоих устройств.
 */
import * as fs from 'fs';
import * as path from 'path';

const SYNC = path.join(__dirname, '..', 'disappearSync.ts');
const CHAT = path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx');

const src = fs.readFileSync(SYNC, 'utf8');
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

const setBody = (): string => bodyOf(src, 'export async function setDisappearAndSync(');
const warnBody = (): string => bodyOf(src, 'function disappearWarning(');

describe('v4.32.448 — итог рассылки таймера обязан быть назван', () => {
  it('DisappearSyncResult — размеченное объединение, отказ всегда с текстом', () => {
    expect(src).toContain(
      'export type DisappearSyncResult = { synced: true } | { synced: false; warning: string };'
    );
    expect(src).toContain('}): Promise<DisappearSyncResult> {');
    // Пустого выхода не осталось: раньше вся функция была Promise<void>.
    expect(src).not.toContain('  ms: number;\n}): Promise<void> {');
    expect(src).not.toContain('warning?:');
  });

  it('ни один выход не молчит', () => {
    const b = setBody();
    expect(b).not.toBe('');
    const mute = codeLines(b).filter((l) => l.trim() === 'return;');
    expect(mute).toEqual([]);
    expect(b).toContain('return { synced: false, warning: disappearWarning(ms, delivery.reason) };');
    expect(b).toContain('return { synced: true };');
  });

  it('таймер ставится у себя до отправки — отказ рассылки его не отменяет', () => {
    const b = setBody();
    const local = b.indexOf('await setConversationDisappearTimer(');
    const send = b.indexOf('fanoutControlEnvelope(');
    expect(local).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(local).toBeLessThan(send);
    // И отказ — ниже отправки, иначе он снова окажется догадкой.
    expect(send).toBeLessThan(b.indexOf('if (!delivery.sent)'));
  });

  it('своей копии отправки у таймера не осталось', () => {
    const code = codeLines(src).join('\n');
    expect(code).not.toContain('getMessagingService');
    expect(code).not.toContain('svc.sendMessage(');
    expect(code).toContain("fanoutControlEnvelope('disappear'");
  });
});

describe('v4.32.448 — текст предупреждения говорит про обе стороны', () => {
  it('включение и выключение описаны по-разному', () => {
    const b = warnBody();
    expect(b).not.toBe('');
    expect(b).toContain("const head = ms > 0 ? 'Таймер включён только у вас' : 'Таймер выключен только у вас';");
    expect(b).toContain("? 'У него сообщения этой переписки удаляться не будут'");
    expect(b).toContain("      : 'У него сообщения этой переписки продолжат удаляться';");
    // Причина названа: «нет связи» и «собеседник не определён» — разные беды.
    expect(b).toContain("const why = fanoutReasonText(reason, 'dm');");
  });

  it('обе ветки текста считаются от ms, а не от одной догадки', () => {
    const b = warnBody();
    expect(b.split('ms > 0').length - 1).toBe(2);
  });
});

describe('v4.32.448 — экран проговаривает расхождение', () => {
  it('после выбора значения отказ показывается', () => {
    expect(chatSrc).toContain('if (!res.synced) showError(res.warning);');
    expect(chatSrc).not.toContain(
      'setDisappearAndSync({ peerPubB64: peerB64, ms }).then(() => setDisappearMs(ms))'
    );
    // Значение на экране обновляется в любом случае: у себя таймер уже стоит.
    expect(chatSrc).toContain('setDisappearMs(ms);');
  });

  it('обещание в модалке осталось на месте — именно его и проверяем', () => {
    expect(chatSrc).toContain('Выбранное время действует у обоих собеседников');
  });
});

describe('v4.32.448 — код до правки этот рэтчет не проходит', () => {
  const BEFORE = [
    'const svc = getMessagingService();',
    'if (!svc) {',
    "  log.warn('disappear_no_service');",
    '  return;',
    '}',
    'try {',
    '  await svc.sendMessage(peerPubB64, encodeDisappearEnvelope({ ms, ts }));',
    '} catch (e) {',
    "  log.warn('disappear_send_failed', { to: peerPubB64.slice(0, 12) });",
    '}',
  ].join('\n');

  it('старый выход был пустым и неотличимым от успеха', () => {
    expect(BEFORE).toContain('  return;');
    expect(BEFORE).not.toContain('synced');
    expect(BEFORE).not.toContain('warning');
  });

  it('старая отправка была своей копией', () => {
    expect(BEFORE).toContain('getMessagingService()');
    expect(BEFORE).not.toContain('fanoutControlEnvelope(');
  });
});
