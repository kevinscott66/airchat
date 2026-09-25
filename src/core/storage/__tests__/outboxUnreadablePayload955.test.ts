/**
 * v4.32.955 — рэтчет: непрочитанный конверт не выдаётся за отправленный.
 *
 * ДЕФЕКТ. `outboxDrain` расшифровывал столбец через `decryptAtRestString`, а
 * тот на любом отказе открытия отдаёт ПУСТУЮ СТРОКУ — неотличимо от честно
 * пустой нагрузки. Дальше `parseDmRetryPayload('')` возвращал `null`, ветка
 * разбора считала строку испорченной («drop so we don't retry forever») и
 * ставила `outcome = { kind: 'delivered' }`: строка удалялась из очереди и
 * засчитывалась в число отправленных.
 *
 * ЦЕНА. Заблокированный после перезагрузки Keychain или занятая на секунду
 * база — и неотправленное личное сообщение стирается навсегда, а человеку
 * показывается «отправлено». Повторить нечем: строки в очереди больше нет,
 * кнопки повтора у отправителя тоже.
 *
 * ПРАВКА. `outboxDrain` читает через `tryDecryptAtRest`, и `OutboxItem.payload`
 * стал `string | null`. Разбор очереди отвечает на `null` отдельной веткой:
 * попытка тратится (причина проходящая, но не бесконечно — потолок попыток
 * уводит строку в dead-letter), а строка остаётся на месте.
 *
 * ГРАНИЦЫ. Набор поведенческий: `local` подставной и отдаёт `null` там, где
 * настоящий вернул бы его после правки; проверяется решение `sync.ts`. Выбор
 * функции расшифровки в самом `local.ts` держат две проверки по исходнику в
 * конце файла — без них половину правки можно было бы снять незаметно.
 */
import * as fs from 'fs';
import * as path from 'path';

type Row = {
  id: number;
  kind: string;
  payload: string | null;
  createdAt: number;
  priority: number;
  ownerProfileId: number | null;
  attempts: number;
};

/** Потолок попыток продублирован: фабрики jest.mock не видят внешних имён. */
const mockMaxAttempts = 20;

let mockRows: Row[] = [];
let mockSentIds: number[] = [];
let mockCtlIds: string[] = [];
let mockDmOk = true;

const mockLive = (): Row[] =>
  mockRows
    .filter((r) => r.attempts < mockMaxAttempts)
    .sort((a, b) => b.priority - a.priority || a.id - b.id);

jest.mock('../local', () => ({
  OUTBOX_DRAIN_LIMIT: 200,
  outboxDrain: async (limit: number, offset: number) =>
    mockLive()
      .slice(offset, offset + limit)
      .map((r) => ({ ...r })),
  outboxDeleteById: async (id: number) => {
    mockRows = mockRows.filter((r) => r.id !== id);
  },
  // Возвращает то же, что и настоящая: останется ли строка в следующей выборке.
  outboxIncrementAttempts: async (id: number) => {
    const row = mockRows.find((r) => r.id === id);
    if (!row) return false;
    row.attempts += 1;
    return row.attempts < mockMaxAttempts;
  },
  outboxPurgeDead: async () => undefined,
}));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1 }) },
}));

jest.mock('../../social/messaging', () => ({
  getMessagingService: () => ({
    ownerProfileId: async () => 1,
    retrySendDm: async (p: { messageId: string }) => {
      mockSentIds.push(Number(p.messageId.slice(1)));
      return mockDmOk;
    },
    retrySendCtl: async (p: { targetMessageId: string }) => {
      mockCtlIds.push(p.targetMessageId);
      return true;
    },
  }),
}));

// Разбор нагрузки берётся настоящий: именно его ответ на непрочитанную строку
// и приводил к удалению, подставлять сюда упрощение значило бы проверять свою
// же выдумку.
jest.mock('../../transport/ipfs/heliaNode', () => ({ isIpfsEnabled: () => true }));
jest.mock('../../transport/ipfs/node', () => ({ addToIpfs: async () => 'cid' }));
jest.mock('../../transport/ipfs/pubsub', () => ({ pubsubPublish: async () => true }));

jest.mock('../../logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runSyncIfOnline } from '../sync';

/** Ключ собеседника — 44 символа base64, как требует разбор нагрузки. */
const PUB = 'A'.repeat(44);

function dmPayload(id: number): string {
  return JSON.stringify({
    contactPubB64: PUB,
    text: 'привет',
    mediaCids: [],
    messageId: `m${id}`,
    ts: 1_700_000_000_000,
  });
}

function ctlPayload(target: string): string {
  return JSON.stringify({ op: 'delete', contactPubB64: PUB, targetMessageId: target });
}

/** Строка очереди; `payload: null` — столбец не открылся ключом устройства. */
function row(id: number, payload: string | null, kind = 'dm', attempts = 0): Row {
  return {
    id,
    kind,
    payload,
    createdAt: Date.now(),
    priority: 0,
    ownerProfileId: 1,
    attempts,
  };
}

/** Один проход синхронизации; отдаёт число, которое ушло в «отправлено». */
async function sync(): Promise<number> {
  let sent = -1;
  await runSyncIfOnline({ onSyncComplete: (n: number) => { sent = n; } });
  return sent;
}

const idsLeft = (): number[] => mockRows.map((r) => r.id).sort((a, b) => a - b);

beforeEach(() => {
  mockRows = [];
  mockSentIds = [];
  mockCtlIds = [];
  mockDmOk = true;
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прочитанная строка проходит очередь как прежде', () => {
  it('личное сообщение уходит, строка удаляется и попадает в счёт', async () => {
    mockRows = [row(1, dmPayload(1))];
    expect(await sync()).toBe(1);
    expect(idsLeft()).toEqual([]);
    expect(mockSentIds).toEqual([1]);
  });

  it('служебный конверт уходит так же', async () => {
    mockRows = [row(2, ctlPayload('m9'), 'ctl')];
    expect(await sync()).toBe(1);
    expect(idsLeft()).toEqual([]);
    expect(mockCtlIds).toEqual(['m9']);
  });

  it('отказ отправки оставляет строку и тратит попытку', async () => {
    mockDmOk = false;
    mockRows = [row(3, dmPayload(3))];
    expect(await sync()).toBe(0);
    expect(idsLeft()).toEqual([3]);
    expect(mockRows[0].attempts).toBe(1);
  });
});

describe('непрочитанная нагрузка не выдаётся за доставленную', () => {
  it('личное сообщение остаётся в очереди, а не исчезает', async () => {
    mockRows = [row(1, null)];
    expect(await sync()).toBe(0);
    expect(idsLeft()).toEqual([1]);
  });

  it('отправка даже не пробуется: отправлять нечего', async () => {
    mockRows = [row(1, null)];
    await sync();
    expect(mockSentIds).toEqual([]);
  });

  it('попытка всё же тратится — вечного круга не будет', async () => {
    mockRows = [row(1, null)];
    await sync();
    expect(mockRows[0].attempts).toBe(1);
  });

  it('упершись в потолок попыток, строка уходит в dead-letter, а не остаётся навсегда', async () => {
    mockRows = [row(1, null, 'dm', mockMaxAttempts - 1)];
    await sync();
    expect(mockRows[0].attempts).toBe(mockMaxAttempts);
    // Из следующей выборки она уже исключена запросом — её доберёт purge по TTL.
    expect(mockLive()).toEqual([]);
  });

  it('то же для служебного конверта', async () => {
    mockRows = [row(4, null, 'ctl')];
    expect(await sync()).toBe(0);
    expect(idsLeft()).toEqual([4]);
    expect(mockCtlIds).toEqual([]);
  });

  // Эти два вида и до правки не терялись — но случайно: `JSON.parse('')`
  // бросал, и строку спасал общий catch. Теперь они держатся решением.
  it('то же для строк вида msg и blob', async () => {
    mockRows = [row(5, null, 'msg'), row(6, null, 'blob')];
    expect(await sync()).toBe(0);
    expect(idsLeft()).toEqual([5, 6]);
  });

  it('соседняя прочитанная строка в том же окне уходит нормально', async () => {
    mockRows = [row(1, null), row(2, dmPayload(2))];
    expect(await sync()).toBe(1);
    expect(idsLeft()).toEqual([1]);
    expect(mockSentIds).toEqual([2]);
  });

  it('две непрочитанные подряд не съедают друг друга через дедупликацию', async () => {
    mockRows = [row(1, null), row(2, null)];
    expect(await sync()).toBe(0);
    expect(idsLeft()).toEqual([1, 2]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прочитанный мусор по-прежнему выбрасывается', () => {
  it('непригодная, но открытая нагрузка удаляется — её не спасёт ни один повтор', async () => {
    mockRows = [row(1, '{"op":"nonsense"}')];
    expect(await sync()).toBe(1);
    expect(idsLeft()).toEqual([]);
  });

  it('пустая строка, которая действительно лежала в базе, тоже удаляется', async () => {
    mockRows = [row(1, '')];
    expect(await sync()).toBe(1);
    expect(idsLeft()).toEqual([]);
  });

  it('дедупликация прочитанных личных сообщений работает по-прежнему', async () => {
    mockRows = [row(1, dmPayload(7)), row(2, dmPayload(7))];
    expect(await sync()).toBe(1);
    expect(idsLeft()).toEqual([]);
    expect(mockSentIds).toEqual([7]);
  });
});

describe('вторая половина правки: чем читается столбец очереди', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

  it('outboxDrain читает нагрузку отличающей отказ функцией', () => {
    const local = read('core/storage/local.ts');
    expect(local).toContain('payload: tryDecryptAtRest(r.payload, dek)');
    expect(local).not.toContain('payload: decryptAtRestString(r.payload, dek)');
  });

  it('разбор очереди отвечает на непрочитанную нагрузку отдельной веткой', () => {
    const sync = read('core/storage/sync.ts');
    expect(sync).toContain('if (item.payload === null)');
    expect(sync).toContain("log.warn('outbox_payload_unreadable'");
  });
});
