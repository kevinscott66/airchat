/**
 * Отметка о прочтении в группе, которую не приняли (v4.32.716).
 *
 * Экран группы вёл набор «эти отметки уже ушли» и помечал в нём пару
 * «отправитель|сообщение» ещё ДО отправки, а сама отправка возвращала
 * `Promise<void>`: ответ `sendMessage` выбрасывался. Между тем null от
 * `sendMessage` означает ровно одно — конверт не ушёл: исчерпан общий счёт
 * служебных конвертов (его делят реакции, голоса в опросах и рассылка группы),
 * контакт заблокирован, защищённого канала нет или не нашлось ни одного
 * маршрута. Очереди «дошлём потом» за этим нет.
 *
 * Отметка о прочтении — служебный конверт (\x03 в CONTROL_ONLY), поэтому после
 * отказа не остаётся даже строки в переписке. То есть не знал никто: ни экран,
 * ни журнал (он писал `group_read_receipt_sent` при любом исходе), ни человек.
 * Автор сообщения так и не видел, что его прочли, а значок просмотров канала —
 * он считает разных читателей по этим самым отметкам — занижал счёт, и всё это
 * на всё время, что группа открыта.
 *
 * Здесь проверяется: отправка честно называет исход; отказ снимает пометку,
 * чтобы следующая загрузка сообщений попробовала снова; повтор ограничен
 * потолком, иначе заблокированный адресат тянул бы попытку на каждую запись в
 * хранилище; «выключено» и «самому себе» повтора не заслуживают.
 */
import fs from 'fs';
import path from 'path';

let mockCid: string | null = 'cid-716';
let mockThrows = false;
let mockSvcOn = true;
const mockSendMessage = jest.fn(async (_peer: string, _text: string): Promise<string | null> => {
  if (mockThrows) throw new Error('нет маршрута');
  return mockCid;
});
const MY_PID = 7;
jest.mock('../messaging', () => ({
  getMessagingService: () =>
    mockSvcOn
      ? {
          sendMessage: mockSendMessage,
          groupRecipient: async () => ({
            pid: 7,
            pair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
            myPub: 'MYpub',
          }),
        }
      : null,
}));

let mockAllowed = true;
const mockReadReceiptsAllowedFor = jest.fn(async (_pid: number) => mockAllowed);
jest.mock('../../settings/privacyPrefs', () => ({
  readReceiptsAllowedFor: (pid: number) => mockReadReceiptsAllowedFor(pid),
  privacyPrefBoolFor: jest.fn(async () => false),
}));

jest.mock('../../identity/profileManager', () => ({ profileManager: {} }));
jest.mock('../../identity/ownProfile', () => ({ getOwnDisplayName: async () => 'me' }));
jest.mock('../../crypto/keyManager', () => ({ loadKeyPair: async () => null }));
jest.mock('../../storage/local', () => ({}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { sendGroupReadReceipt, GROUP_READ_RECEIPT_PREFIX } from '../groupMessaging';
import { isControlOnlyText } from '../messagePreview';

const mockLog = (jest.requireMock('../../logger') as { log: Record<string, jest.Mock> }).log;

const GROUP = 'g-abcdef0123';
const SENDER = 'SENDERpub';
const ME = 'MYpub';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const GM = (): string => read('core/social/groupMessaging.ts');
const SCREEN = (): string => read('ui/screens/GroupsScreen.tsx');

/** Комментарий — не исполняемый код: ratchet не должен ловиться на пересказ. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Тело именованной функции верхнего уровня, по балансу фигурных скобок. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) return '';
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

const logCalls = (name: string): unknown[][] =>
  [...mockLog.info.mock.calls, ...mockLog.debug.mock.calls, ...mockLog.warn.mock.calls].filter(
    (c) => c[0] === name
  );

beforeEach(() => {
  mockSendMessage.mockClear();
  mockReadReceiptsAllowedFor.mockClear();
  mockLog.info.mockClear();
  mockLog.debug.mockClear();
  mockLog.warn.mockClear();
  mockAllowed = true;
  mockCid = 'cid-716';
  mockThrows = false;
  mockSvcOn = true;
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники и разрешение читаются', () => {
    expect(GM().length).toBeGreaterThan(2000);
    expect(SCREEN().length).toBeGreaterThan(2000);
    expect(fnBody(GM(), 'sendGroupReadReceipt').length).toBeGreaterThan(100);
    expect(MY_PID).toBe(7);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отметка о прочтении — служебный конверт, строки в переписке от неё нет', () => {
    // Отсюда и невидимость отказа: обычное сообщение осталось бы в списке со
    // статусом, а этот конверт не пишет в переписку вообще ничего.
    expect(isControlOnlyText(GROUP_READ_RECEIPT_PREFIX + '{"groupId":"g"}')).toBe(true);
  });

  it('значок просмотров канала опирается на эти самые отметки', () => {
    expect(SCREEN()).toContain('(read-receipt backed)');
  });

  it('загрузку сообщений зовут на каждую запись в хранилище', () => {
    // Потому повтор и должен быть с потолком, а не «пока не получится».
    expect(codeOnly(SCREEN())).toContain('GROUP_RECEIPT_MAX_TRIES');
  });
});

describe('отправка называет исход', () => {
  it('принятый конверт — «sent», и только тогда в журнале «отправлено»', async () => {
    const outcome = await sendGroupReadReceipt(GROUP, 'm1', SENDER, ME);
    expect(outcome).toBe('sent');
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(logCalls('group_read_receipt_sent')).toHaveLength(1);
    expect(logCalls('group_read_receipt_refused')).toHaveLength(0);
  });

  it('отвергнутый конверт — «refused», и в журнале не «отправлено»', async () => {
    mockCid = null;
    const outcome = await sendGroupReadReceipt(GROUP, 'm1', SENDER, ME);
    expect(outcome).toBe('refused');
    expect(logCalls('group_read_receipt_sent')).toHaveLength(0);
    expect(logCalls('group_read_receipt_refused')).toHaveLength(1);
  });

  it('пустая строка вместо cid — тоже отказ', async () => {
    mockCid = '';
    expect(await sendGroupReadReceipt(GROUP, 'm1', SENDER, ME)).toBe('refused');
  });

  it('исключение при отправке — тоже «refused», а не тишина', async () => {
    mockThrows = true;
    expect(await sendGroupReadReceipt(GROUP, 'm1', SENDER, ME)).toBe('refused');
    expect(logCalls('group_read_receipt_sent')).toHaveLength(0);
  });

  it('нет службы переписки — «refused»: стоит попробовать позже', async () => {
    mockSvcOn = false;
    expect(await sendGroupReadReceipt(GROUP, 'm1', SENDER, ME)).toBe('refused');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('выключенные отметки — «off», а не «не ушло»', async () => {
    mockAllowed = false;
    expect(await sendGroupReadReceipt(GROUP, 'm1', SENDER, ME)).toBe('off');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('самому себе — «off»', async () => {
    expect(await sendGroupReadReceipt(GROUP, 'm1', ME, ME)).toBe('off');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('ответ отправки не выбрасывают', () => {
    const body = fnBody(GM(), 'sendGroupReadReceipt');
    const bare = body.split('\n').filter((l) => /^\s*await svc\.sendMessage\(/.test(l));
    expect(bare).toHaveLength(0);
    expect(codeOnly(body)).toContain('const cid = await svc.sendMessage(');
  });
});

describe('экран группы снимает пометку с отвергнутой отметки', () => {
  it('пометку ставят до отправки, а снимают после отказа', () => {
    const src = codeOnly(SCREEN());
    const add = src.indexOf('sentGroupReceiptsRef.current.add(mark);');
    const send = src.indexOf('void sendGroupReadReceipt(');
    const del = src.indexOf('sentGroupReceiptsRef.current.delete(mark);');
    expect(add).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(add);
    expect(del).toBeGreaterThan(send);
  });

  it('снимают только на «refused»', () => {
    expect(codeOnly(SCREEN())).toContain("if (outcome !== 'refused') return;");
  });

  it('отправку больше не бросают без разбора исхода', () => {
    // Строка вида `void sendGroupReadReceipt(...);` — ровно тот вид, при
    // котором исход отправки некуда деть.
    const bare = SCREEN()
      .split('\n')
      .filter((l) => /^\s*void sendGroupReadReceipt\(.*\);\s*$/.test(l));
    expect(bare).toHaveLength(0);
  });

  it('повтор ограничен потолком', () => {
    const src = codeOnly(SCREEN());
    expect(src).toMatch(/const GROUP_RECEIPT_MAX_TRIES = \d+;/);
    expect(src).toContain('if (tries >= GROUP_RECEIPT_MAX_TRIES) return;');
    // Счётчик попыток растёт до проверки потолка, иначе потолок недостижим.
    const inc = src.indexOf('refusedGroupReceiptsRef.current.set(mark, tries);');
    const cap = src.indexOf('if (tries >= GROUP_RECEIPT_MAX_TRIES) return;');
    expect(inc).toBeGreaterThan(-1);
    expect(cap).toBeGreaterThan(inc);
  });

  it('сорванное обещание не роняет загрузку сообщений', () => {
    expect(codeOnly(SCREEN())).toContain('.catch(() => {');
  });
});

describe('журнал рассылки управляющих конвертов группы', () => {
  it('пишет принятое число адресатов, а не задуманное', () => {
    const src = codeOnly(GM());
    const at = src.indexOf("log.info('group_ctl_fanout'");
    expect(at).toBeGreaterThan(-1);
    const tail = src.slice(at, at + 260);
    expect(tail).not.toContain('to: recipients.size');
    expect(tail).toContain('to: res.sent ? res.recipients : 0');
  });

  it('сосед по файлу считает так же', () => {
    expect(codeOnly(GM())).toContain("log.info('group_ctl_direct_sent'");
  });
});
