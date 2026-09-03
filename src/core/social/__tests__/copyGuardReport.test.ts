/**
 * v4.32.568: два новых переключателя карточки профиля — «Запрет на
 * копирование» и «Пожаловаться». Оба обещают меньше, чем кажется по названию,
 * и здесь проверяется именно то, что они действительно делают.
 *
 * Про запрет важно, что сбой чтения не должен выглядеть как включённый
 * запрет — иначе человек решит, что настройка включилась сама. Про жалобу —
 * что она остаётся местной записью: никуда не отправляется, журнал не растёт
 * бесконечно, и испорченная запись не мешает открыть карточку.
 */
const kv: Record<string, string> = {};
let mockBroken = false;

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvGet: jest.fn(async (k: string) => {
    if (mockBroken) throw new Error('db closed');
    return kv[k] ?? null;
  }),
  scopedKvSet: jest.fn(async (k: string, v: string) => { kv[k] = v; }),
  scopedKvDelete: jest.fn(async (k: string) => { delete kv[k]; }),
}));
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { copyGuardKey, isCopyGuarded, setCopyGuard, subscribeCopyGuard } from '../copyGuard';
import {
  hasReported,
  listContactReports,
  recordContactReport,
  REPORT_REASONS,
} from '../contactReport';

const PEER = 'cGVlcg==';
const DID = 'did:key:z6MkTest';

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  mockBroken = false;
});

describe('запрет на копирование', () => {
  it('по умолчанию выключен', async () => {
    await expect(isCopyGuarded(PEER)).resolves.toBe(false);
  });

  it('включается и выключается', async () => {
    await setCopyGuard(PEER, true);
    await expect(isCopyGuarded(PEER)).resolves.toBe(true);
    await setCopyGuard(PEER, false);
    await expect(isCopyGuarded(PEER)).resolves.toBe(false);
  });

  it('выключение стирает ключ, а не пишет «0»', async () => {
    await setCopyGuard(PEER, true);
    await setCopyGuard(PEER, false);
    expect(Object.keys(kv)).not.toContain(copyGuardKey(PEER));
  });

  it('запрет свой у каждой переписки', async () => {
    await setCopyGuard(PEER, true);
    await expect(isCopyGuarded('b3RoZXI=')).resolves.toBe(false);
  });

  it('сбой чтения отвечает «выключено», а не запирает переписку сам', async () => {
    await setCopyGuard(PEER, true);
    mockBroken = true;
    await expect(isCopyGuarded(PEER)).resolves.toBe(false);
  });

  it('экран диалога узнаёт о переключении из карточки профиля', async () => {
    const seen: Array<[string, boolean]> = [];
    const off = subscribeCopyGuard((pub, on) => seen.push([pub, on]));
    await setCopyGuard(PEER, true);
    await setCopyGuard(PEER, false);
    off();
    await setCopyGuard(PEER, true);
    expect(seen).toEqual([[PEER, true], [PEER, false]]);
  });

  it('упавший слушатель не роняет остальных и не отменяет запись', async () => {
    const seen: boolean[] = [];
    const offBad = subscribeCopyGuard(() => { throw new Error('boom'); });
    const offGood = subscribeCopyGuard((_p, on) => seen.push(on));
    await expect(setCopyGuard(PEER, true)).resolves.toBeUndefined();
    offBad(); offGood();
    expect(seen).toEqual([true]);
    await expect(isCopyGuarded(PEER)).resolves.toBe(true);
  });
});

describe('жалоба на контакт', () => {
  it('записывается местно и видна как уже поданная', async () => {
    await expect(hasReported(DID)).resolves.toBe(false);
    await recordContactReport(DID, 'spam', true);
    await expect(hasReported(DID)).resolves.toBe(true);
    const [r] = await listContactReports();
    expect(r.did).toBe(DID);
    expect(r.reason).toBe('spam');
    expect(r.blocked).toBe(true);
    expect(typeof r.at).toBe('number');
  });

  it('новая жалоба идёт первой: журнал читают с конца событий', async () => {
    await recordContactReport(DID, 'spam', false);
    await recordContactReport('did:key:z6MkOther', 'fraud', true);
    expect((await listContactReports()).map((r) => r.reason)).toEqual(['fraud', 'spam']);
  });

  it('журнал не растёт бесконечно', async () => {
    const many = Array.from({ length: 260 }, (_, i) => ({
      did: `did:key:z${i}`, reason: 'other' as const, at: i, blocked: false,
    }));
    kv['contact_reports'] = JSON.stringify(many);
    await recordContactReport(DID, 'abuse', false);
    const all = await listContactReports();
    expect(all.length).toBe(200);
    expect(all[0].did).toBe(DID);
  });

  it('испорченный журнал читается как пустой, а не ломает карточку', async () => {
    kv['contact_reports'] = 'не json';
    await expect(listContactReports()).resolves.toEqual([]);
    kv['contact_reports'] = '{"did":"x"}';
    await expect(listContactReports()).resolves.toEqual([]);
    kv['contact_reports'] = '[null,{"did":1,"at":2},{"did":"ok","at":3}]';
    expect((await listContactReports()).map((r) => r.did)).toEqual(['ok']);
  });

  it('сбой чтения не мешает открыть карточку', async () => {
    mockBroken = true;
    await expect(listContactReports()).resolves.toEqual([]);
    await expect(hasReported(DID)).resolves.toBe(false);
  });

  it('у каждой причины есть человеческая подпись и ни одна не обещает отправки', () => {
    expect(REPORT_REASONS.length).toBeGreaterThan(1);
    for (const r of REPORT_REASONS) {
      expect(r.label.trim().length).toBeGreaterThan(0);
      expect(r.label).not.toMatch(/отправ/i);
    }
  });
});
