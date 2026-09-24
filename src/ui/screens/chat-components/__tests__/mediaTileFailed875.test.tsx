/**
 * v4.32.875. Плитка «📷 …» висела вечно — и на качающемся снимке, и на том,
 * который уже никогда не придёт.
 *
 * Дефект. Разбор вложений отдавал один `null` на два разных исхода: «ещё
 * качается» и «не скачалось». Отличить их было нечем, поэтому в переписке обе
 * плитки рисовались одинаково («📷 …»), а в группе состояние УГАДЫВАЛОСЬ по
 * виду ссылки: `nb:` — крутим индикатор, остальное — «недоступно». Догадка
 * промахивалась ровно в самом частом случае: `nb:`-вложение, которое не
 * скачалось, крутило индикатор до конца жизни пузыря.
 *
 * Цена. Человек ждёт снимок, которого не будет. Ни причины, ни повтора: чтобы
 * попробовать ещё раз, надо было выйти из переписки и вернуться, и то без
 * уверенности — а в группе и это не помогало, потому что плитка выглядела
 * занятой делом.
 *
 * Правка. Разбор отдаёт слот с фазой (`pending` | `ready` | `failed`) и
 * причиной отказа — той самой, что появилась в v4.32.874. Отказ рисуется
 * отдельно, по нажатию называет причину словами (blobResolveText) и запускает
 * повтор. Догадка по виду ссылки убрана: состояние приходит из разбора.
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => { unmount: () => void };
};

type Result = { ok: true; uri: string } | { ok: false; reason: string };

/** Чем кончится следующий разбор и когда именно. */
let mockPending: Array<(r: Result) => void> = [];
let mockNextResult: Result = { ok: true, uri: 'file:///ok.img' };
let mockHoldResolve = false;
let mockResolveCalls = 0;

jest.mock('../../../../core/media/mediaBlob', () => ({
  isNbCid: (s: string) => typeof s === 'string' && s.startsWith('nb:'),
  parseNbCid: (s: string) => (typeof s === 'string' && s.startsWith('nb:') ? { cid: s.slice(3) } : null),
  resolveBlobToLocalFileResult: () => {
    mockResolveCalls += 1;
    if (!mockHoldResolve) return Promise.resolve(mockNextResult);
    return new Promise<Result>((res) => { mockPending.push(res); });
  },
}));
jest.mock('../../../../core/media/gatewayUrl', () => ({
  gatewayUrl: (g: string, cid: string) => (g && !cid.includes('..') ? `${g}/ipfs/${cid}` : ''),
}));
jest.mock('../../../../core/media/mediaResolveLimit', () => ({
  mediaResolveLimiter: { run: (fn: () => Promise<unknown>) => fn() },
}));
jest.mock('../../../../core/logger', () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { useResolvedMediaSlots, type MediaResolveSlot } from '../useResolvedMediaUrls';

const COMP = __dirname.replace(/__tests__$/, '');
const read = (name: string): string => fs.readFileSync(path.join(COMP, name), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const STRIP = (): string => codeOnly(read('MediaStrip.tsx'));
const GRID = (): string => codeOnly(read('GroupPhotoGrid.tsx'));
const HOOK = (): string => codeOnly(read('useResolvedMediaUrls.ts'));

/** Живой рендер хука: слоты и повтор наружу. */
let slots: MediaResolveSlot[] = [];
let retry: () => void = () => {};

function Harness({ entries, gateway }: { entries: string[]; gateway: string }): null {
  const r = useResolvedMediaSlots(entries, gateway);
  slots = r.slots;
  retry = r.retry;
  return null;
}

async function mount(entries: string[], gateway = 'https://gw'): Promise<{ unmount: () => void }> {
  let tree!: { unmount: () => void };
  await act(async () => { tree = TestRenderer.create(<Harness entries={entries} gateway={gateway} />); });
  mounted.push(tree);
  return tree;
}

/** Снимаем харнесс внутри act: незавершённый разбор иначе ругается на setState. */
let mounted: Array<{ unmount: () => void }> = [];
afterEach(async () => {
  const trees = mounted;
  mounted = [];
  await act(async () => { trees.forEach((t) => t.unmount()); });
});

beforeEach(() => {
  mockPending = [];
  mockHoldResolve = false;
  mockResolveCalls = 0;
  mockNextResult = { ok: true, uri: 'file:///ok.img' };
  slots = [];
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('обе плитки по-прежнему на месте и берут разбор из общего хука', () => {
    for (const [name, src] of Object.entries({ 'переписка': STRIP(), 'группа': GRID() })) {
      expect([name, src.includes("from './useResolvedMediaUrls'")]).toEqual([name, true]);
      expect([name, src.includes('const tile = (')]).toEqual([name, true]);
      expect([name, src.length > 2000]).toEqual([name, true]);
    }
  });

  it('разбор и правда доходит до слота — успех виден в живом рендере', async () => {
    await mount(['nb:one']);
    expect(slots[0]).toEqual({ url: 'file:///ok.img', phase: 'ready', reason: null });
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отказ разбора — не выдумка: у него есть причина, и она приходит наружу', async () => {
    mockNextResult = { ok: false, reason: 'offline' };
    await mount(['nb:one']);
    expect(slots[0]?.phase).toBe('failed');
  });

  it('ожидание — тоже настоящее состояние, а не мгновение', async () => {
    mockHoldResolve = true;
    await mount(['nb:one']);
    expect(slots[0]).toEqual({ url: null, phase: 'pending', reason: null });
    await act(async () => { mockPending.forEach((r) => r({ ok: true, uri: 'file:///late.img' })); });
    expect(slots[0]?.phase).toBe('ready');
  });
});

describe('ожидание и отказ — разные состояния', () => {
  it('не скачалось: адреса нет, фаза отказа, причина названа', async () => {
    mockNextResult = { ok: false, reason: 'gone' };
    await mount(['nb:one']);
    expect(slots[0]).toEqual({ url: null, phase: 'failed', reason: 'gone' });
  });

  it('в одной пачке уживаются готовое, ждущее и отказавшее', async () => {
    mockHoldResolve = true;
    await mount(['nb:a', 'nb:b', 'plaincid']);
    expect(slots.map((s) => s.phase)).toEqual(['pending', 'pending', 'ready']);
    await act(async () => {
      mockPending[0]?.({ ok: true, uri: 'file:///a.img' });
      mockPending[1]?.({ ok: false, reason: 'corrupt' });
    });
    expect(slots.map((s) => s.phase)).toEqual(['ready', 'failed', 'ready']);
    expect(slots[1]?.reason).toBe('corrupt');
    expect(slots[2]?.url).toBe('https://gw/ipfs/plaincid');
  });

  it('адрес, который собрать нельзя, — отказ сразу, а не вечное ожидание', async () => {
    await mount(['../etc/passwd'], 'https://gw');
    expect(slots[0]).toEqual({ url: null, phase: 'failed', reason: 'unsupported' });
  });
});

describe('повтор', () => {
  it('после отказа новая попытка и правда уходит в разбор', async () => {
    mockNextResult = { ok: false, reason: 'offline' };
    await mount(['nb:one']);
    expect(mockResolveCalls).toBe(1);
    mockNextResult = { ok: true, uri: 'file:///second.img' };
    await act(async () => { retry(); });
    expect(mockResolveCalls).toBe(2);
    expect(slots[0]).toEqual({ url: 'file:///second.img', phase: 'ready', reason: null });
  });

  it('повтор возвращает плитку в ожидание, а не оставляет старый отказ', async () => {
    mockNextResult = { ok: false, reason: 'offline' };
    await mount(['nb:one']);
    mockHoldResolve = true;
    await act(async () => { retry(); });
    expect(slots[0]?.phase).toBe('pending');
  });

  it('закрытую галерею отказом не метят — отмена это не неудача', () => {
    expect(HOOK()).toContain('if (cancelled || !res) return;');
    expect(HOOK()).toContain('if (cancelled) return null;');
  });
});

describe('прежняя форма хука жива для тех, кому хватает адресов', () => {
  it('useResolvedMediaUrls собран поверх слотов и запоминает массив', () => {
    const h = HOOK();
    expect(h).toContain('const { slots } = useResolvedMediaSlots(entries, gateway);');
    expect(h).toContain('return useMemo(() => slots.map((s) => s.url), [slots]);');
  });
});

describe('плитка отказа говорит и даёт повторить', () => {
  it('в переписке отказ отличается от ожидания и назван по нажатию', () => {
    const s = STRIP();
    expect(s).toContain("slot?.phase === 'failed'");
    expect(s).toContain("showError(blobResolveText(slot.reason ?? 'unknown', 'photo'));");
    expect(s).toContain('retry();');
    expect(s).toContain('нажмите, чтобы повторить');
  });

  it('в группе состояние больше не угадывается по виду ссылки', () => {
    const g = GRID();
    expect(g).not.toContain('isNbCid(entries[i]');
    expect(g).not.toContain('const pending = isNbCid(');
    expect(g).toContain("slot?.phase === 'failed'");
    expect(g).toContain("showError(blobResolveText(slot.reason ?? 'unknown', 'photo'));");
    expect(g).toContain('retry();');
  });

  it('ожидание в обеих плитках осталось отдельным видом', () => {
    expect(STRIP()).toContain('📷 …');
    expect(GRID()).toContain('<ActivityIndicator size="small" color={mutedColor} />');
  });
});
