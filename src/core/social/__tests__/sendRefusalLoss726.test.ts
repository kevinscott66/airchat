/**
 * v4.32.726: молчаливый отказ отправки больше не уносит набранное.
 *
 * Экран переписки очищает поле ввода, ответ и черновик ДО отправки — иначе он
 * замирал бы на время сети. Возвращать их назад умел только `catch`. А отправка
 * отвечает отказом молча: `sendMessage` возвращает null, не бросая, когда
 * контакт заблокирован, исчерпан часовой лимит, нет общего ключа или ключ
 * собеседника негоден. Ни одна из этих веток до строки в переписке не доходит.
 *
 * Значит текст, набранный человеком, переставал существовать где бы то ни было:
 * поле пустое, строки нет, а предварительный пузырь оставался висеть с часами
 * «отправляется» до первой перерисовки списка. То же — с записанным голосовым,
 * с уже загруженным документом, с видео и с GIF.
 *
 * Разобрать два разных null снаружи нельзя: отсутствие маршрута тоже отвечает
 * null, но строку в переписке оставляет (со статусом «не отправлено» и кнопкой
 * «Повторить») — и вернуть текст в поле ввода там значило бы написать его
 * дважды. Поэтому исход теперь называется словом: `sent` | `stored` | `refused`.
 *
 * Проверяется исходник: экран в jest не поднимается, а вся суть правки — в том,
 * какая ветка что делает с набранным.
 */
import * as fs from 'fs';
import * as path from 'path';

const MESSAGING = (): string =>
  fs.readFileSync(path.join(__dirname, '..', 'messaging.ts'), 'utf8');
const CHAT = (): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'), 'utf8');

/** Строки без комментариев: пояснение не должно подменять проверку. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('исход отправки называется словом', () => {
  it('три состояния, и ни одно не необязательное поле', () => {
    const src = codeOnly(MESSAGING());
    expect(src).toContain("export type DmSendOutcome = 'sent' | 'stored' | 'refused';");
    expect(src).toContain(
      'export type DmSendResult = { outcome: DmSendOutcome; cid: string | null };'
    );
  });

  it('отправка отвечает исходом, а прежний sendMessage — обёртка над ней', () => {
    const src = codeOnly(MESSAGING());
    expect(src).toContain('async sendMessageResult(');
    const wrapper = slice(src, '  async sendMessage(', '  private async sendMessageWork(');
    expect(wrapper).toContain('await this.sendMessageResult(');
    expect(wrapper).toContain('return res.cid;');
    // Обёртка ничего не решает сама: все проверки остались в одном месте.
    expect(wrapper).not.toContain('rateLimiter');
    expect(wrapper).not.toContain('isMyOwnKey');
  });
});

describe('отказ до строки в переписке зовётся отказом', () => {
  const body = (): string =>
    slice(codeOnly(MESSAGING()), '  async sendMessageResult(', '  private async sendMessageWork(');

  it('блокировка и оба часовых лимита', () => {
    const b = body();
    expect(b.split("return { outcome: 'refused', cid: null };").length - 1).toBe(3);
    expect(b).toContain("code: 'BLOCKED_CONTACT',");
    expect(b).toContain("code: 'RATE_LIMIT_DM',");
    expect(b).toContain('if (!rateLimiter.canSendControl(contactPubB64)) {');
  });

  it('нет общего ключа и негодный ключ собеседника', () => {
    const work = codeOnly(MESSAGING()).slice(
      codeOnly(MESSAGING()).indexOf('  private async sendMessageWork(')
    );
    const noSession = work.indexOf("code: 'NO_SESSION_DM',");
    const noPeer = work.indexOf("if (!peerDid) return { outcome: 'refused', cid: null };");
    const row = work.indexOf('const messageId = uuidv4();');
    expect(noSession).toBeGreaterThan(0);
    expect(noPeer).toBeGreaterThan(noSession);
    // Обе ветки — раньше, чем заведена строка: возвращать нечего.
    expect(row).toBeGreaterThan(noPeer);
  });

  it('своя переписка без строки — тоже отказ, а не успех', () => {
    expect(body()).toContain("return { outcome: selfCid ? 'sent' : 'refused', cid: selfCid };");
  });
});

describe('отсутствие маршрута — не отказ: строка сохранена', () => {
  const work = (): string => {
    const src = codeOnly(MESSAGING());
    return src.slice(src.indexOf('  private async sendMessageWork('));
  };

  it('сохранённое называется stored и только когда оно вправду сохранено', () => {
    const w = work();
    // v4.32.781: запись обёрнута в проверку исхода — строка та же, слово
    // `stored` по-прежнему стоит после неё.
    const saved = w.indexOf("markDelivered({ cid: null, status: 'failed', transport: null })");
    const verdict = w.indexOf(
      "return { outcome: control || callerOwnsRow ? 'refused' : 'stored', cid: null };"
    );
    expect(saved).toBeGreaterThan(0);
    expect(verdict).toBeGreaterThan(saved);
    // saveRow молча ничего не пишет для служебного конверта и живой
    // геолокации — там сохранять нечего, и исход не должен обещать обратного.
    // v4.32.781: то же правило, но словом: «писать было не нужно» теперь
    // отличается от «не записалось».
    expect(w).toContain("if (control || callerOwnsRow) return 'skipped';");
  });

  it('ушедшее по запасному пути остаётся успехом', () => {
    expect(work()).toContain("return { outcome: 'sent', cid: fallbackRef };");
    expect(work()).toContain("return { outcome: 'sent', cid };");
  });
});

describe('экран переписки возвращает набранное', () => {
  const chat = (): string => codeOnly(CHAT());

  it('текст: поле, ответ и пузырь — назад, и сказано словами', () => {
    const b = slice(chat(), "measurePerformance('chat_send_text'", 'void appendNewMessages();');
    expect(b).toContain('svc.sendMessageResult(');
    expect(b).toContain("if (res.outcome === 'refused') {");
    expect(b).toContain('setMsg(text);');
    expect(b).toContain('msgRef.current = text;');
    expect(b).toContain('setReplyTo(replyRef);');
    expect(b).toContain('setOptimisticOutgoing(null);');
    expect(b).toContain("showError('Отправить не удалось. Текст вернулся в поле ввода');");
  });

  it('вложение: подпись — назад', () => {
    const b = slice(chat(), "measurePerformance('chat_send_media'", 'void appendNewMessages();');
    expect(b).toContain('svc.sendMessageResult(');
    expect(b).toContain("if (res.outcome === 'refused') {");
    expect(b).toContain('setMsg(text);');
    expect(b).toContain('setOptimisticOutgoing(null);');
  });

  it('голосовое: отказ равен неудаче загрузки — тот же catch, та же уборка', () => {
    const b = slice(chat(), 'const voiceText = makeVoiceText(result.uri, result.durationMs, blob);', 'await appendNewMessages();');
    expect(b).toContain('const res = await svc.sendMessageResult(peerB64, voiceText);');
    expect(b).toContain(
      "if (res.outcome === 'refused') throw new Error('Голосовое не отправлено. Запишите заново.');"
    );
  });

  it('видео: отказ считается отдельно от непомещающихся файлов', () => {
    const c = chat();
    expect(c.split("if (res.outcome === 'refused') { refusedCount++; continue; }").length - 1).toBe(2);
    expect(c.split('let refusedCount = 0;').length - 1).toBe(2);
    expect(
      c.split('showError(`Отправить не удалось (видео: ${refusedCount}). Попробуйте ещё раз`)').length - 1
    ).toBe(2);
    // «Не удалось загрузить видео» о неудаче ОТПРАВКИ больше не врёт: до этой
    // строки дело доходит, только когда ни один файл не загрузился.
    expect(c).toContain("else if (!sentAny) showError('Не удалось загрузить видео');");
  });

  it('документ, GIF, геолокация и карточка контакта больше не уходят в тишину', () => {
    const c = chat();
    for (const text of [
      "showError('Документ не отправлен. Попробуйте ещё раз'); return;",
      "showError('GIF не отправлен. Попробуйте ещё раз'); return;",
      "showError('Геолокация не отправлена. Попробуйте ещё раз');",
      "showError('Карточка контакта не отправлена. Попробуйте ещё раз');",
    ]) {
      expect(c).toContain(text);
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('поле ввода по-прежнему очищается до отправки, а не после', () => {
    const c = codeOnly(CHAT());
    const clear = c.indexOf("    setMsg('');\n    msgRef.current = '';\n    setReplyTo(null);");
    const send = c.indexOf("measurePerformance('chat_send_text'");
    expect(clear).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(clear);
  });

  it('прежняя подпись sendMessage сохранена — по одному null отказ не отличить', () => {
    expect(codeOnly(MESSAGING())).toContain('  ): Promise<string | null> {');
  });

  it('восстановление набранного при исключении осталось на месте', () => {
    const c = codeOnly(CHAT());
    expect(c).toContain("log.error('chat_send_failed', { err: errMsg });");
  });
});
