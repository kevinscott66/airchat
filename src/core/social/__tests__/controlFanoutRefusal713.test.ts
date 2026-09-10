/**
 * Рэтчет v4.32.713: null от sendMessage — это отказ, а не принятый конверт.
 *
 * Что ломалось. fanoutControlEnvelope считал адресата охваченным по факту
 * вызова: `await svc.sendMessage(pub, payload); accepted += 1;`. Но sendMessage
 * объявлен как `Promise<string | null>`, и null он отдаёт в шести местах, и все
 * шесть — это твёрдый отказ: контакт заблокирован, исчерпан часовой лимит
 * служебных конвертов, исчерпан часовой лимит сообщений, нет общего ключа
 * сессии, не разобран peerDid, нет ни одного маршрута в сеть.
 *
 * Оправдание в шапке модуля («конверт мог быть положен в очередь повторной
 * отправки, различить нельзя») исходником не подтверждается. Очереди нет:
 * outboxEnqueue из продакшена не вызывается — это закреплено отдельным
 * рэтчетом, — а строку в chat_messages служебный конверт вообще не заводит,
 * потому что saveRow при control — пустышка. Значит, находить пересыльщику
 * нечего, и «не ушло» означает «не уйдёт никогда».
 *
 * Цена ошибки. Реакция, голос в опросе, завершение опроса, срок исчезновения,
 * закреп в личке, запрет копирования, управляющий конверт группы и
 * приглашение, не дошедшие НИ ДО КОГО, возвращали `{ sent: true }`. Весь
 * аппарат предупреждений v4.32.446/447 — undeliveredText, «остальные об этом
 * не узнали» — молчал ровно в том случае, ради которого написан: когда нет
 * связи или упёрлись в лимит.
 *
 * Проверяем поведением: модуль импортируется, а сервис отправки подменяется.
 */
import * as fs from 'fs';
import * as path from 'path';

type Svc = { sendMessage: (pub: string, payload: string) => Promise<string | null> } | null;

let mockSvc: Svc = null;

jest.mock('../messaging', () => ({
  getMessagingService: (): Svc => mockSvc,
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { fanoutControlEnvelope } from '../controlFanout';

const SOC = path.join(__dirname, '..');
const FANOUT = fs.readFileSync(path.join(SOC, 'controlFanout.ts'), 'utf8');
const MESSAGING = fs.readFileSync(path.join(SOC, 'messaging.ts'), 'utf8');
const OUTBOX_RATCHET = fs.readFileSync(
  path.join(SOC, '..', 'storage', '__tests__', 'outboxEnqueueChecked.test.ts'),
  'utf8'
);

/** Строки без комментариев — чтобы запреты не срабатывали на пояснениях. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

beforeEach(() => {
  mockSvc = null;
});

describe('v4.32.713 — непринятый конверт не выдаётся за разосланный', () => {
  it('все адресаты отказали — это all_failed, а не успех', async () => {
    mockSvc = { sendMessage: async () => null };
    const res = await fanoutControlEnvelope('react', 'p', {
      kind: 'group',
      recipients: ['a', 'b', 'c'],
    });
    expect(res).toEqual({ sent: false, reason: 'all_failed' });
  });

  it('часть отказала — в recipients попадают только ушедшие', async () => {
    mockSvc = { sendMessage: async (pub: string) => (pub === 'a' ? 'cid-a' : null) };
    const res = await fanoutControlEnvelope('poll', 'p', {
      kind: 'group',
      recipients: ['a', 'b', 'c'],
    });
    expect(res).toEqual({ sent: true, recipients: 1 });
  });

  it('пустая строка тоже отказ: идентификатор конверта не бывает пустым', async () => {
    mockSvc = { sendMessage: async () => '' };
    const res = await fanoutControlEnvelope('pin', 'p', { kind: 'group', recipients: ['a'] });
    expect(res).toEqual({ sent: false, reason: 'all_failed' });
  });

  it('исключение и null считаются одинаково — оба не дошли', async () => {
    mockSvc = {
      sendMessage: async (pub: string) => {
        if (pub === 'a') throw new Error('нет сети');
        return null;
      },
    };
    const res = await fanoutControlEnvelope('dis', 'p', { kind: 'group', recipients: ['a', 'b'] });
    expect(res).toEqual({ sent: false, reason: 'all_failed' });
  });

  it('личка: отказ единственного адресата виден как all_failed', async () => {
    mockSvc = { sendMessage: async () => null };
    const res = await fanoutControlEnvelope('cg', 'p', { kind: 'dm', peerPubB64: 'peer' });
    expect(res).toEqual({ sent: false, reason: 'all_failed' });
  });

  it('успешная рассылка по-прежнему успех', async () => {
    mockSvc = { sendMessage: async () => 'cid' };
    const res = await fanoutControlEnvelope('react', 'p', {
      kind: 'group',
      recipients: ['a', 'b'],
    });
    expect(res).toEqual({ sent: true, recipients: 2 });
  });
});

describe('v4.32.713 — правка не задела остальные исходы воронки', () => {
  it('группа без других участников остаётся законной: успех с нулём', async () => {
    mockSvc = { sendMessage: async () => null };
    const res = await fanoutControlEnvelope('gctl', 'p', { kind: 'group', recipients: [] });
    expect(res).toEqual({ sent: true, recipients: 0 });
  });

  it('личка без собеседника — no_peer, до всякой отправки', async () => {
    const calls: string[] = [];
    mockSvc = {
      sendMessage: async (pub: string) => {
        calls.push(pub);
        return 'cid';
      },
    };
    const res = await fanoutControlEnvelope('pin', 'p', { kind: 'dm' });
    expect(res).toEqual({ sent: false, reason: 'no_peer' });
    expect(calls).toEqual([]);
  });

  it('нет сервиса отправки — no_service', async () => {
    mockSvc = null;
    const res = await fanoutControlEnvelope('react', 'p', { kind: 'group', recipients: ['a'] });
    expect(res).toEqual({ sent: false, reason: 'no_service' });
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежняя редакция воронки этот рэтчет не проходит', () => {
  /** Дословный счёт до правки: вызов состоялся — значит принято. */
  async function fanoutBefore(
    recipients: string[],
    send: (pub: string) => Promise<string | null>
  ): Promise<{ sent: boolean; recipients: number }> {
    let accepted = 0;
    await Promise.allSettled(
      recipients.map(async (pub) => {
        try {
          await send(pub);
          accepted += 1;
        } catch {
          /* в лог */
        }
      })
    );
    if (accepted === 0 && recipients.length > 0) return { sent: false, recipients: 0 };
    return { sent: true, recipients: accepted };
  }

  it('старый счёт объявлял успехом рассылку, не дошедшую ни до кого', async () => {
    const before = await fanoutBefore(['a', 'b', 'c'], async () => null);
    expect(before).toEqual({ sent: true, recipients: 3 });

    mockSvc = { sendMessage: async () => null };
    const now = await fanoutControlEnvelope('react', 'p', {
      kind: 'group',
      recipients: ['a', 'b', 'c'],
    });
    expect(now).toEqual({ sent: false, reason: 'all_failed' });
  });

  it('старый счёт завышал число охваченных при частичном отказе', async () => {
    const before = await fanoutBefore(['a', 'b', 'c'], async (pub) =>
      pub === 'a' ? 'cid-a' : null
    );
    expect(before).toEqual({ sent: true, recipients: 3 });
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: null действительно означает «не уйдёт никогда»', () => {
  it('sendMessage объявлен так, что null отличим от идентификатора', () => {
    expect(MESSAGING).toContain(
      [
        '  async sendMessage(',
        '    contactPubB64: string,',
        '    text: string,',
        '    mediaUris?: string[],',
        '    replyToId?: string,',
        '    replyToPreview?: string',
        '  ): Promise<string | null> {',
      ].join('\n')
    );
  });

  it('отказы до отправки возвращают именно null', () => {
    const code = codeOnly(MESSAGING);
    expect(code).toContain('if (!rateLimiter.canSendControl(contactPubB64)) {');
    expect(code).toContain("code: 'NO_SESSION_DM',");
    // Хвост «маршрута нет»: строка помечается провалом и возвращается null.
    expect(code).toContain("await saveRow({ ...pending, status: 'failed' });");
    expect(code).toContain("log.info('dm_send_no_online_route', { peerDid, messageId });");
  });

  it('служебный конверт не оставляет за собой строки, которую можно переслать', () => {
    const code = codeOnly(MESSAGING);
    expect(code).toContain('const control = isControlOnlyText(text);');
    expect(code).toContain('if (!control && !callerOwnsRow) await upsertChatMessage(row);');
  });

  it('очереди повторной отправки нет — это закреплено отдельным рэтчетом', () => {
    expect(OUTBOX_RATCHET).toContain("expect(MESSAGING).not.toContain('outboxEnqueue(');");
  });

  it('воронка считает принятым только непустой ответ', () => {
    const code = codeOnly(FANOUT);
    expect(code).toContain('const cid = await svc.sendMessage(pub, payload);');
    expect(code).toContain('if (cid) {');
    expect(code).toContain("log.warn('control_fanout_send_refused', { op, to: pub.slice(0, 12) });");
    // Голый счёт «вызвали — значит приняли» обратно не вернуть.
    expect(code).not.toContain('await svc.sendMessage(pub, payload);\n        accepted += 1;');
  });

  it('шапка модуля больше не ссылается на несуществующую очередь', () => {
    expect(FANOUT).not.toContain('очередь повторной отправки, различить их по null нельзя');
    expect(FANOUT).toContain('очереди повторной отправки у служебного конверта нет');
  });
});
