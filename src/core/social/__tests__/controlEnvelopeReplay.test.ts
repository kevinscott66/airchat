/**
 * Повтор служебного конверта не откатывает состояние переписки (v4.32.615).
 *
 * Конверт живёт тридцать суток — ровно столько, сколько кадр лежит на relay, —
 * и всё это время остаётся подписанным и «свежим». Единственной защитой от
 * повторного применения был Set в памяти: он гибнет при перезапуске
 * приложения, а служебные конверты вдобавок выходят из обработки раньше, чем в
 * базе появится строка с их messageId, так что и проверка «такое сообщение уже
 * есть» их не ловит. Темы relay выводятся из открытых DID, писать в них может
 * кто угодно — перехваченный кадр отправляется заново хоть через месяц.
 *
 * Цена конкретная: снятый запрет копирования включается обратно, спрятанное
 * «был(а) в сети» снова показывается, автоудаление возвращается на старый срок.
 */

const mockKv = new Map<string, string>();
let mockKvReadFails = false;

jest.mock('../../storage/local', () => ({
  kvTryGet: async (k: string) => (mockKvReadFails ? null : { value: mockKv.get(k) ?? null }),
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
  kvListKeysByPrefix: async () => [],
  // v4.32.814: список «не отмечай меня» лёг в секретную пару — без неё
  // служба читает «не знаем» и перестаёт писать время входа.
  kvSetSecret: async (k: string, v: string) => {
    mockKv.set(k, v);
    return true;
  },
  kvGetSecretCellScoped: async (pid: number, k: string) => {
    if (mockKvReadFails) return { state: 'unreadable' };
    const raw = mockKv.get(`p${pid}:${k}`);
    return raw === undefined ? { state: 'absent' } : { state: 'plain', text: raw };
  },
  setConversationDisappearTimer: async (peer: string, pid: number, ms: number) => {
    // v4.32.750: запись отчитывается о себе — как и запрет копирования.
    if (mockTimerApplyFails) return false;
    mockTimers.push({ peer, pid, ms });
    return true;
  },
  saveChatMessage: async (row: { id: string }) => {
    mockRows.push(row.id);
  },
  // v4.32.767: приёмник пишет различающей формой — отказ базы больше не
  // выдаётся за повтор. Здесь запись всегда удаётся.
  saveChatMessageChecked: async (row: { id: string }) => {
    const seen = mockRows.includes(row.id);
    mockRows.push(row.id);
    return seen ? 'duplicate' : 'inserted';
  },
}));

const mockTimers: { peer: string; pid: number; ms: number }[] = [];
const mockRows: string[] = [];
const mockGuards: { pid: number; peer: string; on: boolean }[] = [];
let mockGuardApplyFails = false;
let mockTimerApplyFails = false;
const mockPresence: { pid: number; peer: string; show: boolean }[] = [];
let mockPresenceApplyFails = false;

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1, name: 'Личный', did: 'did:key:z1' }) },
}));
jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => ({ sent: true }),
  fanoutReasonText: () => '',
}));
jest.mock('../copyGuard', () => ({
  setCopyGuard: async () => true,
  setPeerCopyGuardFor: async (pid: number, peer: string, on: boolean) => {
    // v4.32.655: запись отчитывается о себе — отказ базы больше не молчит.
    if (mockGuardApplyFails) return false;
    mockGuards.push({ pid, peer, on });
    return true;
  },
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => [] }));
jest.mock('../messaging', () => ({ getMessagingService: () => null }));
jest.mock('../presenceService', () => ({
  // v4.32.751: запись отчитывается о себе — как запрет копирования и таймер.
  setPeerLastSeenAllowedFor: async (pid: number, peer: string, show: boolean) => {
    if (mockPresenceApplyFails) return false;
    mockPresence.push({ pid, peer, show });
    return true;
  },
  setMyLastSeenVisibility: async () => {},
  effectiveMyLastSeenVisibility: async () => 'everybody',
  presenceOwnerPid: () => 1,
}));
jest.mock('../../settings/privacyPrefs', () => ({
  privacyPrefTryGetFor: async () => ({ value: 'everybody' }),
}));
jest.mock('../sendGate', () => ({ canReachPeer: async () => ({ ok: true }) }));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  commitControlTs,
  commitGroupControlTs,
  controlTsFresh,
  groupControlTsFresh,
  groupWatermarkKey,
  watermarkKey,
  WATERMARK_PREFIX,
  type ControlKind,
  type GroupControlSlot,
} from '../controlWatermark';

/**
 * Прежняя слитная форма «проверить и сразу сдвинуть». С v4.32.778 её в
 * приложении нет — осталась только здесь, чтобы проверять сами правила отметки
 * (монотонность, окно будущего, раздельность ячеек) в одну строку. В приёмниках
 * такая форма запрещена: см. комментарий у `controlTsFresh`.
 */
async function acceptControlTs(
  kind: ControlKind,
  peerPubB64: string,
  pid: number,
  ts: number
): Promise<boolean> {
  if (!(await controlTsFresh(kind, peerPubB64, pid, ts))) return false;
  await commitControlTs(kind, peerPubB64, pid, ts);
  return true;
}

/** Та же слитная форма для слотов группы — тоже только для этих проверок. */
async function acceptGroupControlTs(
  slot: GroupControlSlot,
  groupId: string,
  pid: number,
  ts: number
): Promise<boolean> {
  if (!(await groupControlTsFresh(slot, groupId, pid, ts))) return false;
  await commitGroupControlTs(slot, groupId, pid, ts);
  return true;
}
import { handleIncomingDisappear, encodeDisappearEnvelope } from '../disappearSync';
import { handleIncomingCopyGuard, encodeCopyGuardEnvelope } from '../copyGuardSync';
import { handleIncomingLastSeenPref } from '../presencePrefSync';
import { encodePresencePrefEnvelope } from '../presenceEnvelope';
import { resetControlTsMirrorForTests } from '../controlWatermark';

const PEER = 'сосед-открытый-ключ==';
const OTHER = 'другой-открытый-ключ==';
const PID = 1;

beforeEach(() => {
  // v4.32.791: зеркало знака живёт на уровне модуля — убираем его, иначе
  // применённое соседней проверкой судило бы конверты этой.
  resetControlTsMirrorForTests();
  mockKv.clear();
  mockKvReadFails = false;
  mockTimers.length = 0;
  mockRows.length = 0;
  mockGuards.length = 0;
  mockGuardApplyFails = false;
  mockTimerApplyFails = false;
  mockPresence.length = 0;
  mockPresenceApplyFails = false;
});

describe('водяной знак служебных конвертов', () => {
  it('первый конверт проходит, его повтор — нет', async () => {
    expect(await acceptControlTs('disappear', PEER, PID, 1000)).toBe(true);
    expect(await acceptControlTs('disappear', PEER, PID, 1000)).toBe(false);
  });

  it('конверт старее уже применённого отвергается', async () => {
    expect(await acceptControlTs('disappear', PEER, PID, 2000)).toBe(true);
    expect(await acceptControlTs('disappear', PEER, PID, 1999)).toBe(false);
    expect(await acceptControlTs('disappear', PEER, PID, 2001)).toBe(true);
  });

  it('метка из далёкого будущего не принимается и не закрывает приём', async () => {
    const far = Date.now() + 60 * 60 * 1000;
    expect(await acceptControlTs('copyguard', PEER, PID, far)).toBe(false);
    // Записи не осталось: иначе все последующие честные конверты стали бы «старыми».
    expect(await acceptControlTs('copyguard', PEER, PID, Date.now())).toBe(true);
  });

  it('нечисловая и нулевая метка отвергаются', async () => {
    expect(await acceptControlTs('presence', PEER, PID, Number.NaN)).toBe(false);
    expect(await acceptControlTs('presence', PEER, PID, 0)).toBe(false);
    expect(await acceptControlTs('presence', PEER, PID, -5)).toBe(false);
  });

  it('знаки не смешиваются между видами состояний, собеседниками и профилями', async () => {
    expect(await acceptControlTs('disappear', PEER, PID, 5000)).toBe(true);
    expect(await acceptControlTs('copyguard', PEER, PID, 1000)).toBe(true);
    expect(await acceptControlTs('disappear', OTHER, PID, 1000)).toBe(true);
    expect(await acceptControlTs('disappear', PEER, 2, 1000)).toBe(true);
  });

  it('ключ несёт номер профиля: kv общий на всё приложение', async () => {
    await acceptControlTs('disappear', PEER, 7, 1000);
    const keys = [...mockKv.keys()];
    expect(keys).toContain(`p7:${watermarkKey('disappear', PEER)}`);
    expect(keys.every((k) => k.startsWith('p7:'))).toBe(true);
    expect(watermarkKey('disappear', PEER).startsWith(WATERMARK_PREFIX)).toBe(true);
  });

  it('нечитаемая база не выключает применение настроек собеседника', async () => {
    mockKvReadFails = true;
    expect(await acceptControlTs('disappear', PEER, PID, 1000)).toBe(true);
  });
});

describe('повтор конверта автоудаления', () => {
  it('старое значение таймера не возвращается', async () => {
    const now = Date.now();
    const week = encodeDisappearEnvelope({ ms: 7 * 24 * 3600_000, ts: now - 10_000 });
    const day = encodeDisappearEnvelope({ ms: 24 * 3600_000, ts: now - 1_000 });
    expect(await handleIncomingDisappear(week, PEER, PID)).toBe('consumed');
    expect(await handleIncomingDisappear(day, PEER, PID)).toBe('consumed');
    // Повтор перехваченного первого кадра.
    expect(await handleIncomingDisappear(week, PEER, PID)).toBe('consumed');
    expect(mockTimers.map((t) => t.ms)).toEqual([7 * 24 * 3600_000, 24 * 3600_000]);
    // И системной строки о нём в переписке тоже не появляется.
    expect(mockRows.length).toBe(2);
  });

  it('таймер соседней переписки повтором не сбивается', async () => {
    const now = Date.now();
    const env = encodeDisappearEnvelope({ ms: 3600_000, ts: now - 5_000 });
    expect(await handleIncomingDisappear(env, PEER, PID)).toBe('consumed');
    expect(await handleIncomingDisappear(env, OTHER, PID)).toBe('consumed');
    expect(mockTimers.map((t) => t.peer)).toEqual([PEER, OTHER]);
  });
});

describe('повтор конверта запрета копирования', () => {
  it('снятый запрет не включается обратно', async () => {
    const now = Date.now();
    const on = encodeCopyGuardEnvelope({ on: true, ts: now - 10_000 });
    const off = encodeCopyGuardEnvelope({ on: false, ts: now - 1_000 });
    expect(await handleIncomingCopyGuard(on, PEER, PID)).toBe('consumed');
    expect(await handleIncomingCopyGuard(off, PEER, PID)).toBe('consumed');
    expect(await handleIncomingCopyGuard(on, PEER, PID)).toBe('consumed');
    expect(mockGuards.map((g) => g.on)).toEqual([true, false]);
  });
});

describe('повтор конверта «показывать время входа»', () => {
  it('спрятанное «был(а) в сети» не открывается обратно', async () => {
    const now = Date.now();
    const show = encodePresencePrefEnvelope({ show: true, ts: now - 10_000 });
    const hide = encodePresencePrefEnvelope({ show: false, ts: now - 1_000 });
    expect(await handleIncomingLastSeenPref(show, PEER, PID)).toBe('consumed');
    expect(await handleIncomingLastSeenPref(hide, PEER, PID)).toBe('consumed');
    expect(await handleIncomingLastSeenPref(show, PEER, PID)).toBe('consumed');
    expect(mockPresence.map((p) => p.show)).toEqual([true, false]);
  });
});

describe('во всех трёх обработчиках знак двигается после применения', () => {
  function code(name: string): string {
    return readFileSync(join(__dirname, '..', name), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  // Общая форма всех трёх: слитная проверка делала проверку и сдвиг одним
  // движением, и применить между ними нечего. Там, где применение умеет
  // отказать, это делало отказ вечным — v4.32.655 (запрет копирования),
  // v4.32.750 (таймер) и v4.32.751 (время входа). Поведение каждого проверено
  // своим describe; здесь — что ни один не вернулся к слитной проверке.
  it.each([
    ['copyGuardSync.ts', 'copyguard', 'setPeerCopyGuardFor(ownerPid'],
    ['disappearSync.ts', 'disappear', 'setConversationDisappearTimer(senderPubB64'],
    ['presencePrefSync.ts', 'presence', 'setPeerLastSeenAllowedFor(ownerProfileId'],
  ])('%s: свежесть → применение → сдвиг', (file, kind, apply) => {
    const c = code(file);
    expect(c).not.toContain(`acceptControlTs('${kind}'`);
    const fresh = c.indexOf(`controlTsFresh('${kind}'`);
    const applyAt = c.indexOf(apply);
    const commit = c.indexOf(`commitControlTs('${kind}'`);
    expect(fresh).toBeGreaterThan(0);
    expect(applyAt).toBeGreaterThan(fresh);
    expect(commit).toBeGreaterThan(applyAt);
  });

  it('слитной формы в самом модуле знака больше нет (v4.32.778)', () => {
    // Позвать её было неоткуда: производственных вызовов не осталось ещё после
    // v4.32.774, а экспорт остался — и это мина. Любой следующий приёмник,
    // написанный «по образцу», получил бы ровно тот дефект, который с v4.32.655
    // по v4.32.777 разминировали по одному. Слитная форма живёт теперь только в
    // этом файле, локальной обёрткой, и применять ей нечего.
    const wm = code('controlWatermark.ts');
    expect(wm).not.toContain('export async function acceptControlTs(');
    expect(wm).not.toContain('export async function acceptGroupControlTs(');
    expect(wm).not.toContain('async function acceptTs(');
    // ПРОВЕРКА НЕ ПУСТАЯ: раздельная пара на месте, и обе её половины.
    expect(wm).toContain('export async function controlTsFresh(');
    expect(wm).toContain('export async function commitControlTs(');
    expect(wm).toContain('export async function groupControlTsFresh(');
    expect(wm).toContain('export async function commitGroupControlTs(');
  });
});

describe('запрет копирования: знак двигается после применения', () => {
  /**
   * Пара «проверить свежесть → применить → сдвинуть» вместо acceptControlTs
   * (v4.32.655). Сдвиг до применения делал отказ вечным: запись у себя могла не
   * лечь, а повтор того же конверта отвергался уже как старый — запрет
   * собеседника не включался никогда, и никто об этом не узнавал.
   */
  it('проверка свежести ничего не пишет', async () => {
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(true);
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(true);
    expect(mockKv.size).toBe(0);
  });

  it('проверка не пустая: после сдвига та же метка уже не проходит', async () => {
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(true);
    await commitControlTs('copyguard', PEER, PID, 2000);
    expect(mockKv.size).toBe(1);
    expect(await controlTsFresh('copyguard', PEER, PID, 2000)).toBe(false);
    expect(await controlTsFresh('copyguard', PEER, PID, 1999)).toBe(false);
    expect(await controlTsFresh('copyguard', PEER, PID, 2001)).toBe(true);
  });

  it('не легшая запись оставляет конверт повторяемым', async () => {
    const on = encodeCopyGuardEnvelope({ on: true, ts: Date.now() - 10_000 });
    mockGuardApplyFails = true;
    expect(await handleIncomingCopyGuard(on, PEER, PID)).toBe('deferred');
    expect(mockGuards).toEqual([]);
    // Знак не сдвинут, а кадр отложен (v4.32.759): относить его к разобранным
    // значило двинуть метку релея — второго конверта никто не пришлёт.
    expect(mockKv.size).toBe(0);
    expect(mockRows).toEqual([]);
    mockGuardApplyFails = false;
    expect(await handleIncomingCopyGuard(on, PEER, PID)).toBe('consumed');
    expect(mockGuards.map((g) => g.on)).toEqual([true]);
    expect(mockKv.size).toBe(1);
  });

  it('удавшееся применение знак двигает — повтор не проходит', async () => {
    const on = encodeCopyGuardEnvelope({ on: true, ts: Date.now() - 10_000 });
    expect(await handleIncomingCopyGuard(on, PEER, PID)).toBe('consumed');
    expect(await handleIncomingCopyGuard(on, PEER, PID)).toBe('consumed');
    expect(mockGuards.map((g) => g.on)).toEqual([true]);
  });

  it('порядок в исходнике: свежесть → применение → сдвиг', () => {
    const c = readFileSync(join(__dirname, '..', 'copyGuardSync.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const fresh = c.indexOf("controlTsFresh('copyguard'");
    const apply = c.indexOf('setPeerCopyGuardFor(ownerPid');
    const commit = c.indexOf("commitControlTs('copyguard'");
    expect(fresh).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(fresh);
    expect(commit).toBeGreaterThan(apply);
    // Старой формы «сдвинуть и применить одним движением» здесь больше нет.
    expect(c).not.toContain("acceptControlTs('copyguard'");
    // Отказ применения виден в журнале, а не только по отсутствию знака.
    expect(c).toContain("log.warn('copy_guard_apply_failed'");
  });
});

describe('автоудаление: знак двигается после применения', () => {
  /**
   * v4.32.750 — та же пара, что у запрета копирования. `setConversationDisappearTimer`
   * молчала о своём отказе (возвращала `void`), а знак двигался до неё: строка
   * диалога не менялась, повтор того же конверта отвергался как старый, и
   * переписка, которую собеседник считает исчезающей, оставалась у нас
   * навсегда. Само собой это не чинится: повтора у служебного конверта нет.
   */
  it('не легшая запись оставляет конверт повторяемым', async () => {
    const day = encodeDisappearEnvelope({ ms: 24 * 3600_000, ts: Date.now() - 10_000 });
    mockTimerApplyFails = true;
    expect(await handleIncomingDisappear(day, PEER, PID)).toBe('deferred');
    expect(mockTimers).toEqual([]);
    // Знак не сдвинут, а кадр отложен (v4.32.759) — тот же конверт придёт снова.
    expect(mockKv.size).toBe(0);
    // И системной строки о непроизошедшем в переписке не появилось.
    expect(mockRows).toEqual([]);

    mockTimerApplyFails = false;
    expect(await handleIncomingDisappear(day, PEER, PID)).toBe('consumed');
    expect(mockTimers.map((t) => t.ms)).toEqual([24 * 3600_000]);
    expect(mockKv.size).toBe(1);
    expect(mockRows).toHaveLength(1);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: удавшееся применение знак двигает — повтор не проходит', async () => {
    const day = encodeDisappearEnvelope({ ms: 24 * 3600_000, ts: Date.now() - 10_000 });
    expect(await handleIncomingDisappear(day, PEER, PID)).toBe('consumed');
    expect(await handleIncomingDisappear(day, PEER, PID)).toBe('consumed');
    expect(mockTimers.map((t) => t.ms)).toEqual([24 * 3600_000]);
  });

  it('отказ записи назван в журнале', () => {
    // Порядок «свежесть → применение → сдвиг» закреплён общим рэтчетом выше;
    // здесь — что молчаливого отказа не осталось.
    const c = readFileSync(join(__dirname, '..', 'disappearSync.ts'), 'utf8');
    expect(c).toContain("log.warn('disappear_apply_failed'");
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: запись таймера отвечает булевым', () => {
    const local = readFileSync(join(__dirname, '..', '..', 'storage', 'local.ts'), 'utf8');
    expect(local).toContain('  disappearAfterMs: number | null\n): Promise<boolean> {');
  });
});

describe('время входа: знак двигается после применения', () => {
  /**
   * v4.32.751 — третий обработчик той же формы. `setPeerLastSeenAllowedFor`
   * писала обе свои записи через `void ... .catch(ignore)`: отказ базы не
   * доходил никуда. В памяти запрет при этом стоял, так что до перезапуска всё
   * выглядело исполненным, а после — список поднимался без него.
   *
   * Второй раз собеседник просьбу не пришлёт: у него в `presence:pref_sent`
   * записано, что мы её получили. Человек просил не отмечать его время входа —
   * и оно снова показывалось всем, кому видно.
   */
  it('не легшая запись оставляет конверт повторяемым', async () => {
    const hide = encodePresencePrefEnvelope({ show: false, ts: Date.now() - 10_000 });
    mockPresenceApplyFails = true;
    expect(await handleIncomingLastSeenPref(hide, PEER, PID)).toBe('deferred');
    expect(mockPresence).toEqual([]);
    // Знак не сдвинут, а кадр отложен (v4.32.759) — ту же просьбу принесут снова.
    expect(mockKv.size).toBe(0);

    mockPresenceApplyFails = false;
    expect(await handleIncomingLastSeenPref(hide, PEER, PID)).toBe('consumed');
    expect(mockPresence.map((p) => p.show)).toEqual([false]);
    expect(mockKv.size).toBe(1);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: удавшееся применение знак двигает — повтор не проходит', async () => {
    const hide = encodePresencePrefEnvelope({ show: false, ts: Date.now() - 10_000 });
    expect(await handleIncomingLastSeenPref(hide, PEER, PID)).toBe('consumed');
    expect(await handleIncomingLastSeenPref(hide, PEER, PID)).toBe('consumed');
    expect(mockPresence.map((p) => p.show)).toEqual([false]);
  });

  it('отказ записи назван в журнале', () => {
    const c = readFileSync(join(__dirname, '..', 'presencePrefSync.ts'), 'utf8');
    expect(c).toContain("log.warn('presence_pref_apply_failed'");
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: учёт просьбы отвечает булевым', () => {
    const svc = readFileSync(join(__dirname, '..', 'presenceService.ts'), 'utf8');
    expect(svc).toContain('export async function setPeerLastSeenAllowedFor(');
    expect(svc).toContain('  allow: boolean\n): Promise<boolean> {');
    // Обе записи просьбы — проверяемые: `scopedKvSetFor` отдаёт void, и её
    // `.catch(ignore)` как раз и был молчанием.
    const at = svc.indexOf('export async function setPeerLastSeenAllowedFor(');
    const body = svc.slice(at, svc.indexOf('\n}\n', at));
    expect(body).not.toContain('scopedKvSetFor(');
    // v4.32.814: список запретов ушёл в секретную пару — проверяемы обе записи
    // по-прежнему, изменилось имя одной из них.
    expect(body.split('scopedKvSetCheckedFor(').length - 1).toBe(1);
    expect(body.split('scopedKvSetSecretCheckedFor(').length - 1).toBe(1);
  });
});

/**
 * Управляющие конверты группы — тот же повтор, но дороже (v4.32.615).
 *
 * Права проверяются по роли ТОГО, КТО ПОДПИСАЛ ОРИГИНАЛ, а не по тому, кто
 * прислал кадр во второй раз. Значит, перехваченное «назначить админом»
 * возвращает разжалованному администратору права у каждого участника, старое
 * «разбанить» снимает бан, старое «добавить» возвращает исключённого, а старое
 * meta отменяет отзыв пригласительной ссылки и включает обратно автоудаление.
 * И всё это молча: идентификатор системной строки собирается из ts операции,
 * при повторе он совпадает, и INSERT OR IGNORE ничего не пишет.
 */
describe('водяной знак управляющих конвертов группы', () => {
  const GID = 'g-1';
  const MEMBER = 'участник-ключ==';

  it('повтор и откат по одному участнику отвергаются', async () => {
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 2000)).toBe(true);
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 2000)).toBe(false);
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 1999)).toBe(false);
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 2001)).toBe(true);
  });

  it('состав одного человека — один скаляр: ban, role и kick делят знак', async () => {
    // Иначе старое «назначить админом» проходило бы после свежего бана.
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 3000)).toBe(true);
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 2500)).toBe(false);
  });

  it('участники, группы и профили не делят знак', async () => {
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 5000)).toBe(true);
    expect(await acceptGroupControlTs(`m:${OTHER}`, GID, PID, 1000)).toBe(true);
    expect(await acceptGroupControlTs(`m:${MEMBER}`, 'g-2', PID, 1000)).toBe(true);
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, 2, 1000)).toBe(true);
  });

  it('у каждого поля настроек свой знак', async () => {
    // Настройки группы — не одно значение: relay отдаёт накопленное пачкой без
    // гарантии порядка, и общий знак выбросил бы законное переименование,
    // пришедшее следом за более поздней сменой аватара.
    expect(await acceptGroupControlTs('meta:avatarCid', GID, PID, 9000)).toBe(true);
    expect(await acceptGroupControlTs('meta:name', GID, PID, 8000)).toBe(true);
    expect(await acceptGroupControlTs('meta:name', GID, PID, 8000)).toBe(false);
  });

  it('идентификатор группы стоит последним — иначе он подбирал бы чужой ключ', () => {
    // Кодек ограничивает groupId только длиной, двоеточие в нём допустимо.
    const spoof = groupWatermarkKey('meta:name', `x:m:${MEMBER}`);
    const real = groupWatermarkKey(`m:${MEMBER}`, 'x');
    expect(spoof).not.toBe(real);
    expect(groupWatermarkKey(`m:${MEMBER}`, GID).startsWith(WATERMARK_PREFIX)).toBe(true);
  });

  it('нечитаемая база не выключает управление группой', async () => {
    mockKvReadFails = true;
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 1000)).toBe(true);
  });
});

/**
 * Проверка и сдвиг знака разделены (v4.32.618).
 *
 * Обработчик состава сдвигал знак ДО switch, а ветки внутри сплошь
 * идемпотентные: бан уже забаненного, та же роль, add уже состоящего — каждая
 * выходит, ничего не изменив. Знак при этом оставался сдвинутым навсегда, и
 * следующий законный конверт с меньшей меткой отвергался как повтор.
 */
describe('свежесть проверяется отдельно от сдвига знака', () => {
  const GID = 'g-9';
  const MEMBER = 'участник-ключ==';

  it('проверка ничего не пишет — её можно повторить', async () => {
    expect(await groupControlTsFresh(`m:${MEMBER}`, GID, PID, 2000)).toBe(true);
    expect(await groupControlTsFresh(`m:${MEMBER}`, GID, PID, 2000)).toBe(true);
    expect(mockKv.size).toBe(0);
  });

  it('проверка не пустая: после сдвига та же метка уже не проходит', async () => {
    expect(await groupControlTsFresh(`m:${MEMBER}`, GID, PID, 2000)).toBe(true);
    await commitGroupControlTs(`m:${MEMBER}`, GID, PID, 2000);
    expect(mockKv.size).toBe(1);
    expect(await groupControlTsFresh(`m:${MEMBER}`, GID, PID, 2000)).toBe(false);
    expect(await groupControlTsFresh(`m:${MEMBER}`, GID, PID, 1999)).toBe(false);
    expect(await groupControlTsFresh(`m:${MEMBER}`, GID, PID, 2001)).toBe(true);
  });

  it('пачка в обратном порядке: не применённый role не хоронит законный add', async () => {
    // role (T2) пришёл раньше add (T1), участника не нашёл и вышел — знак
    // двигать было не за что.
    expect(await groupControlTsFresh(`m:${MEMBER}`, GID, PID, 2000)).toBe(true);
    // add (T1) применяется и двигает знак сам.
    expect(await groupControlTsFresh(`m:${MEMBER}`, GID, PID, 1000)).toBe(true);
    await commitGroupControlTs(`m:${MEMBER}`, GID, PID, 1000);
    // А вот прежнее поведение (сдвиг до switch) участника теряло навсегда.
    mockKv.clear();
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 2000)).toBe(true);
    expect(await acceptGroupControlTs(`m:${MEMBER}`, GID, PID, 1000)).toBe(false);
  });

  it('сдвиг знака одного слота не задевает соседние', async () => {
    await commitGroupControlTs(`m:${MEMBER}`, GID, PID, 5000);
    expect(await groupControlTsFresh(`m:${OTHER}`, GID, PID, 1000)).toBe(true);
    expect(await groupControlTsFresh('meta:name', GID, PID, 1000)).toBe(true);
    expect(await groupControlTsFresh(`m:${MEMBER}`, 'g-10', PID, 1000)).toBe(true);
  });
});

describe('проверка стоит в обработчике группы до применения', () => {
  const SRC = readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('ban/unban/kick/add/role гасятся раньше switch, а знак двигается после', () => {
    const sw = SRC.indexOf('switch (env.op) {');
    expect(sw).toBeGreaterThan(0);
    const check = SRC.indexOf('groupControlTsFresh(`m:${env.target}`');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(sw);
    /**
     * v4.32.618: сдвиг знака — строго ПОСЛЕ switch. Ветки внутри сплошь
     * идемпотентные: бан уже забаненного, та же роль, add уже состоящего —
     * каждая возвращает управление, ничего не изменив. Знак, сдвинутый до
     * них, хоронил законный конверт: add (T1) и role (T2) пришли из relay
     * пачкой в обратном порядке, role не нашёл участника и вышел, знак встал
     * на T2 — и add с T1 отвергся как повтор.
     */
    const commit = SRC.indexOf('commitGroupControlTs(`m:${env.target}`');
    expect(commit).toBeGreaterThan(sw);
    expect(SRC).not.toContain('acceptGroupControlTs(`m:${env.target}`');
  });

  it('«вышел сам» делит знак с составом, а не заводит свой', () => {
    // v4.32.774: знак тот же (`m:`), но спрашивается и двигается двумя
    // действиями — как у ban/kick/role. Прежний accept сдвигал его ДО удаления
    // из списка, и отказ базы в промежутке хоронил выход навсегда.
    const at = SRC.indexOf('groupControlTsFresh(`m:${senderPubB64}`');
    expect(at).toBeGreaterThan(0);
    const removed = SRC.indexOf('removeGroupMember(env.groupId, senderPubB64, pid)');
    expect(at).toBeLessThan(removed);
    expect(SRC.indexOf('commitGroupControlTs(`m:${senderPubB64}`', removed)).toBeGreaterThan(removed);
  });

  it('каждое поле настроек спрашивает свой знак', () => {
    // v4.32.620: знак поля СПРАШИВАЕТСЯ до применения (groupControlTsFresh), а
    // двигается только после того, как записи легли (commitGroupControlTs).
    // Прежний acceptGroupControlTs делал и то и другое разом, на десятки строк
    // раньше самой записи: упавшая транзакция оставляла отметку впереди
    // непринятого состояния, и повтор отвергался как дубль навсегда.
    expect(SRC).toContain("groupControlTsFresh(`meta:${field}`, env.groupId, pid, env.ts)");
    expect(SRC).not.toContain('acceptGroupControlTs(`meta:');
    for (const field of [
      'name',
      'description',
      'avatarCid',
      'adminOnlyPosting',
      'adminOnlyPinning',
      'requireApproval',
      'anonymousPosting',
      'inviteToken',
      'slowModeSeconds',
      'disappearMs',
    ]) {
      expect(SRC).toContain(`(await fresh('${field}'))`);
    }
    // Порядок: спросили -> записали -> подтвердили. Проверяем по номерам строк,
    // иначе перестановка commit обратно наверх прошла бы незамеченной.
    const lines = SRC.split('\n');
    const freshAt = lines.findIndex((l) => l.includes('groupControlTsFresh(`meta:${field}`'));
    const commitAt = lines.findIndex((l) => l.includes('commitGroupControlTs(`meta:${field}`'));
    const writeAt = Math.max(
      lines.findIndex((l) => l.includes('await updateGroupMeta(env.groupId, pid, patch)')),
      lines.findIndex((l) => l.includes('await setGroupSlowMode(env.groupId, pid, env.slowModeSeconds)')),
      lines.findIndex((l) => l.includes('await setGroupDisappearTimer(env.groupId, pid,')),
    );
    expect(freshAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(freshAt);
    expect(commitAt).toBeGreaterThan(writeAt);
    expect(SRC).toContain('for (const field of acceptedMeta) await commitGroupControlTs(');
  });
});
