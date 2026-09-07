/**
 * Правку сообщения группы нельзя подать дважды (v4.32.628).
 *
 * `edit` — единственный управляющий конверт группы, который ЗАМЕНЯЕТ уже
 * показанный человеку текст, и до этой версии он применялся без единой
 * проверки метки времени: `updateGroupMessageText` делает безусловный UPDATE.
 * Кадр живёт на relay тридцать суток, темы выводятся из открытых DID, писать
 * в них может кто угодно, а `seenMessageIds` держится только в памяти — то
 * есть перехваченный подписанный кадр возвращал сообщение к старому тексту у
 * всех получателей хоть через месяц, и молча: системной строки правка не
 * пишет.
 *
 * Знак — на КАЖДОЕ сообщение, а не на отправителя: правки приходят пачкой без
 * гарантии порядка, и общий знак выбросил бы законную правку сообщения A,
 * пришедшую следом за более поздней правкой B. Имя ячейки поэтому своё, и
 * идентификатор сообщения в нём последний — ровно по той же причине, по
 * которой последним стоит идентификатор группы в groupWatermarkKey: кодек
 * ограничивает msgId только длиной, двоеточие внутри разрешено.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockKv = new Map<string, string>();
const mockReadFail = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockReadFail.has(k) ? null : { value: mockKv.get(k) ?? null }),
  kvSet: async (k: string, v: string) => {
    mockKv.set(k, v);
  },
  kvSetChecked: async (k: string, v: string) => {
    mockKv.set(k, v);
    return true;
  },
  kvDelete: async (k: string) => {
    mockKv.delete(k);
  },
  kvDeleteChecked: async (k: string) => {
    mockKv.delete(k);
  },
  kvListKeysByPrefix: async () => [],
}));
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1, name: 'Личный', did: 'did:key:z1' }) },
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  commitGroupMessageTs,
  groupMessageTsFresh,
  groupMessageWatermarkKey,
  groupWatermarkKey,
  WATERMARK_PREFIX,
} from '../controlWatermark';

const PID = 1;
const NOW = Date.now();

beforeEach(() => {
  mockKv.clear();
  mockReadFail.clear();
});

describe('повтор правки сообщения группы', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: первая правка проходит, тот же кадр следом — уже нет', async () => {
    expect(await groupMessageTsFresh('m1', PID, NOW - 60_000)).toBe(true);
    await commitGroupMessageTs('m1', PID, NOW - 60_000);
    // Тот самый перехваченный кадр: подпись цела, метка та же.
    expect(await groupMessageTsFresh('m1', PID, NOW - 60_000)).toBe(false);
    // И любой кадр старше отметки — тоже.
    expect(await groupMessageTsFresh('m1', PID, NOW - 120_000)).toBe(false);
    // А законная следующая правка — проходит.
    expect(await groupMessageTsFresh('m1', PID, NOW - 30_000)).toBe(true);
  });

  it('знак у каждого сообщения свой: поздняя правка B не глушит раннюю правку A', async () => {
    // Порядок доставки relay не гарантирован: сначала пришла более поздняя
    // правка сообщения B, следом — более ранняя, но законная правка A.
    await commitGroupMessageTs('mB', PID, NOW - 10_000);
    expect(await groupMessageTsFresh('mA', PID, NOW - 60_000)).toBe(true);
    // Убедимся, что общий знак действительно отверг бы её: у самого B такая
    // метка уже несвежая.
    expect(await groupMessageTsFresh('mB', PID, NOW - 60_000)).toBe(false);
  });

  it('двоеточие внутри msgId не даёт подобрать чужую ячейку', async () => {
    // Кодек ограничивает msgId только длиной (<=128), двоеточия разрешены.
    expect(groupMessageWatermarkKey('a:b')).not.toBe(groupMessageWatermarkKey('a'));
    expect(groupMessageWatermarkKey('a:b')).not.toBe(groupMessageWatermarkKey('b'));
    await commitGroupMessageTs('a:b', PID, NOW - 10_000);
    expect(await groupMessageTsFresh('a', PID, NOW - 60_000)).toBe(true);
    // И ячейка сообщения не пересекается с ячейкой отправителя (`grp:m:`),
    // сколько бы двоеточий ни было в идентификаторах.
    expect(groupMessageWatermarkKey('msg:x')).not.toBe(groupWatermarkKey('m:msg', 'x'));
    expect(groupMessageWatermarkKey('x')).toBe(`${WATERMARK_PREFIX}grp:msg:x`);
  });

  it('отказ чтения базы не запирает правку навсегда', async () => {
    // Общее правило водяных знаков: читать не смогли — пропускаем. Иначе одна
    // занятая база стоила бы человеку всех последующих правок в группе.
    await commitGroupMessageTs('m1', PID, NOW - 10_000);
    mockReadFail.add(`p${PID}:${groupMessageWatermarkKey('m1')}`);
    expect(await groupMessageTsFresh('m1', PID, NOW - 60_000)).toBe(true);
  });
});

describe('порядок «проверить — применить — отметить» в ветке edit/del', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'groupMessaging.ts'), 'utf8');
  const start = src.indexOf("if (env.op === 'edit' || env.op === 'del') {");
  const end = src.indexOf("log.info('group_ctl_msgop_applied'", start);
  const branch = src.slice(start, end);

  it('ПРОВЕРКА НЕ ПУСТАЯ: ветка найдена и содержит применение правки', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(branch).toContain('updateGroupMessageText(env.msgId, env.text, pid)');
    expect(branch).toContain('deleteGroupMessage(env.msgId, pid)');
  });

  it('свежесть спрашивается до применения, а отметка двигается после', () => {
    const gate = branch.indexOf('groupMessageTsFresh(env.msgId, pid, env.ts)');
    const apply = branch.indexOf('updateGroupMessageText(');
    const del = branch.indexOf('deleteGroupMessage(');
    const commit = branch.indexOf('commitGroupMessageTs(env.msgId, pid, env.ts)');
    expect(gate).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(apply);
    expect(gate).toBeLessThan(del);
    // Отметка — последней: правка может не найти строки и кончиться ничем,
    // и сдвинутый вперёд знак отверг бы следующую законную правку как повтор.
    expect(commit).toBeGreaterThan(apply);
    expect(commit).toBeGreaterThan(del);
  });

  it('несвежий кадр уходит с журналом, а не молча', () => {
    expect(branch).toContain("log.warn('group_ctl_msgop_stale_drop'");
  });
});
