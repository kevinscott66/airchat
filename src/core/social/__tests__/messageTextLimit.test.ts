/**
 * Потолок длины текста сообщения (v4.32.508).
 *
 * Проверяется не само число, а то, что оно одно на всех: приём лички, приём
 * группы, планировщик отложенных и обе очереди повторной отправки спрашивают
 * один модуль, а не выписывают 64 000 у себя.
 */
import fs from 'fs';
import path from 'path';
import {
  MAX_MESSAGE_TEXT,
  isSendableMessageText,
  withinMessageTextLimit,
} from '../messageTextLimit';

const SRC = path.join(__dirname, '..', '..', '..');
const SOCIAL = path.join(SRC, 'core', 'social');

/** Строки кода без комментариев — правило про код, а не про рассказ о нём. */
function codeLines(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    });
}

describe('withinMessageTextLimit', () => {
  test('обычный текст проходит', () => {
    expect(withinMessageTextLimit('привет')).toBe(true);
  });

  test('пустая строка допустима — сообщение может быть одним вложением', () => {
    expect(withinMessageTextLimit('')).toBe(true);
  });

  test('ровно потолок проходит, потолок плюс один — нет', () => {
    expect(withinMessageTextLimit('x'.repeat(MAX_MESSAGE_TEXT))).toBe(true);
    expect(withinMessageTextLimit('x'.repeat(MAX_MESSAGE_TEXT + 1))).toBe(false);
  });

  test('многомегабайтная строка от собеседника не проходит', () => {
    expect(withinMessageTextLimit('x'.repeat(5_000_000))).toBe(false);
  });

  test('не строка — не проходит и не бросает', () => {
    expect(withinMessageTextLimit(null)).toBe(false);
    expect(withinMessageTextLimit(undefined)).toBe(false);
    expect(withinMessageTextLimit(42)).toBe(false);
    expect(withinMessageTextLimit({ length: 3 })).toBe(false);
    expect(withinMessageTextLimit(['a'])).toBe(false);
  });
});

describe('isSendableMessageText', () => {
  test('непустой текст в границах годится к отправке', () => {
    expect(isSendableMessageText('привет')).toBe(true);
  });

  test('пустой текст в очередь не ставится', () => {
    expect(isSendableMessageText('')).toBe(false);
  });

  test('переросший текст в очередь не ставится', () => {
    expect(isSendableMessageText('x'.repeat(MAX_MESSAGE_TEXT + 1))).toBe(false);
  });

  test('не строка — не годится', () => {
    expect(isSendableMessageText(null)).toBe(false);
    expect(isSendableMessageText(0)).toBe(false);
  });

  test('потолок отправки и потолок приёма — одно число', () => {
    const atLimit = 'x'.repeat(MAX_MESSAGE_TEXT);
    expect(withinMessageTextLimit(atLimit)).toBe(true);
    expect(isSendableMessageText(atLimit)).toBe(true);
  });
});

describe('форма исходников — v4.32.508', () => {
  const mod = fs.readFileSync(path.join(SOCIAL, 'messageTextLimit.ts'), 'utf8');
  const messaging = fs.readFileSync(path.join(SOCIAL, 'messaging.ts'), 'utf8');
  const group = fs.readFileSync(path.join(SOCIAL, 'groupMessaging.ts'), 'utf8');
  const sched = fs.readFileSync(path.join(SOCIAL, 'scheduledMessages.ts'), 'utf8');
  const dmRetry = fs.readFileSync(path.join(SOCIAL, 'dmRetryPayload.ts'), 'utf8');
  const ctlRetry = fs.readFileSync(path.join(SOCIAL, 'ctlRetryPayload.ts'), 'utf8');

  test('модуль без импортов', () => {
    expect(mod).not.toMatch(/^import\s/m);
    expect(mod).not.toContain('require(');
  });

  test('личный приём отбрасывает переросший текст и говорит об этом в журнале', () => {
    expect(messaging).toContain("if (!withinMessageTextLimit(textPayload.text ?? '')) {");
    expect(messaging).toContain("log.warn('dm_text_oversized_drop'");
  });

  test('личный приём чистит список вложений тем же правилом, что и групповой', () => {
    expect(messaging).toContain('const incomingCids = sanitizeMediaCids(textPayload.mediaCids);');
    expect(messaging).not.toContain('JSON.stringify(textPayload.mediaCids)');
    expect(group).toContain('env.mediaCids = sanitizeMediaCids(env.mediaCids);');
  });

  test('групповой приём спрашивает тот же модуль', () => {
    expect(group).toContain('if (!withinMessageTextLimit(env.text)) return true;');
  });

  test('планировщик отложенных спрашивает тот же модуль в обеих проверках', () => {
    expect(sched.match(/if \(!isSendableMessageText\(text\)\) \{/g)).toHaveLength(2);
  });

  test('обе очереди повторной отправки берут потолок оттуда же', () => {
    expect(dmRetry).toContain('const TEXT_MAX = MAX_MESSAGE_TEXT;');
    expect(ctlRetry).toContain('const TEXT_MAX = MAX_MESSAGE_TEXT;');
  });

  test('своего 64 000 в социальном слое не осталось нигде, кроме дома правила', () => {
    const offenders = fs
      .readdirSync(SOCIAL)
      .filter((n) => n.endsWith('.ts') && n !== 'messageTextLimit.ts')
      .filter((n) =>
        codeLines(fs.readFileSync(path.join(SOCIAL, n), 'utf8')).some(
          (l) => l.includes('64_000') || l.includes('64000')
        )
      );
    expect(offenders).toEqual([]);
  });
});
