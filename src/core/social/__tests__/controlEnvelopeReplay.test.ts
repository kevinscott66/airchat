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
  setConversationDisappearTimer: async (peer: string, pid: number, ms: number) => {
    mockTimers.push({ peer, pid, ms });
  },
  saveChatMessage: async (row: { id: string }) => {
    mockRows.push(row.id);
  },
}));

const mockTimers: { peer: string; pid: number; ms: number }[] = [];
const mockRows: string[] = [];
const mockGuards: { pid: number; peer: string; on: boolean }[] = [];
const mockPresence: { pid: number; peer: string; show: boolean }[] = [];

jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: 1, name: 'Личный', did: 'did:key:z1' }) },
}));
jest.mock('../controlFanout', () => ({
  fanoutControlEnvelope: async () => ({ sent: true }),
  fanoutReasonText: () => '',
}));
jest.mock('../copyGuard', () => ({
  setCopyGuard: async () => {},
  setPeerCopyGuardFor: async (pid: number, peer: string, on: boolean) => {
    mockGuards.push({ pid, peer, on });
  },
}));
jest.mock('../contacts', () => ({ listContactsFor: async () => [] }));
jest.mock('../messaging', () => ({ getMessagingService: () => null }));
jest.mock('../presenceService', () => ({
  setPeerLastSeenAllowedFor: (pid: number, peer: string, show: boolean) => {
    mockPresence.push({ pid, peer, show });
  },
  setMyLastSeenVisibility: async () => {},
  effectiveMyLastSeenVisibility: async () => 'everybody',
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
import { acceptControlTs, acceptGroupControlTs, groupWatermarkKey, watermarkKey, WATERMARK_PREFIX } from '../controlWatermark';
import { handleIncomingDisappear, encodeDisappearEnvelope } from '../disappearSync';
import { handleIncomingCopyGuard, encodeCopyGuardEnvelope } from '../copyGuardSync';
import { handleIncomingLastSeenPref } from '../presencePrefSync';
import { encodePresencePrefEnvelope } from '../presenceEnvelope';

const PEER = 'сосед-открытый-ключ==';
const OTHER = 'другой-открытый-ключ==';
const PID = 1;

beforeEach(() => {
  mockKv.clear();
  mockKvReadFails = false;
  mockTimers.length = 0;
  mockRows.length = 0;
  mockGuards.length = 0;
  mockPresence.length = 0;
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
    expect(await handleIncomingDisappear(week, PEER, PID)).toBe(true);
    expect(await handleIncomingDisappear(day, PEER, PID)).toBe(true);
    // Повтор перехваченного первого кадра.
    expect(await handleIncomingDisappear(week, PEER, PID)).toBe(true);
    expect(mockTimers.map((t) => t.ms)).toEqual([7 * 24 * 3600_000, 24 * 3600_000]);
    // И системной строки о нём в переписке тоже не появляется.
    expect(mockRows.length).toBe(2);
  });

  it('таймер соседней переписки повтором не сбивается', async () => {
    const now = Date.now();
    const env = encodeDisappearEnvelope({ ms: 3600_000, ts: now - 5_000 });
    expect(await handleIncomingDisappear(env, PEER, PID)).toBe(true);
    expect(await handleIncomingDisappear(env, OTHER, PID)).toBe(true);
    expect(mockTimers.map((t) => t.peer)).toEqual([PEER, OTHER]);
  });
});

describe('повтор конверта запрета копирования', () => {
  it('снятый запрет не включается обратно', async () => {
    const now = Date.now();
    const on = encodeCopyGuardEnvelope({ on: true, ts: now - 10_000 });
    const off = encodeCopyGuardEnvelope({ on: false, ts: now - 1_000 });
    expect(await handleIncomingCopyGuard(on, PEER, PID)).toBe(true);
    expect(await handleIncomingCopyGuard(off, PEER, PID)).toBe(true);
    expect(await handleIncomingCopyGuard(on, PEER, PID)).toBe(true);
    expect(mockGuards.map((g) => g.on)).toEqual([true, false]);
  });
});

describe('повтор конверта «показывать время входа»', () => {
  it('спрятанное «был(а) в сети» не открывается обратно', async () => {
    const now = Date.now();
    const show = encodePresencePrefEnvelope({ show: true, ts: now - 10_000 });
    const hide = encodePresencePrefEnvelope({ show: false, ts: now - 1_000 });
    expect(await handleIncomingLastSeenPref(show, PEER, PID)).toBe(true);
    expect(await handleIncomingLastSeenPref(hide, PEER, PID)).toBe(true);
    expect(await handleIncomingLastSeenPref(show, PEER, PID)).toBe(true);
    expect(mockPresence.map((p) => p.show)).toEqual([true, false]);
  });
});

describe('проверка стоит во всех трёх обработчиках', () => {
  function code(name: string): string {
    return readFileSync(join(__dirname, '..', name), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  it.each([
    ['disappearSync.ts', 'disappear'],
    ['copyGuardSync.ts', 'copyguard'],
    ['presencePrefSync.ts', 'presence'],
  ])('%s гасит устаревший конверт до применения', (file, kind) => {
    const c = code(file);
    expect(c).toContain(`acceptControlTs('${kind}'`);
    // Именно до применения: строка проверки обязана стоять раньше записи.
    const at = c.indexOf('acceptControlTs(');
    const applyAt = Math.min(
      ...[
        'setConversationDisappearTimer(senderPubB64',
        'setPeerCopyGuardFor(ownerPid',
        'setPeerLastSeenAllowedFor(ownerProfileId',
      ]
        .map((s) => c.indexOf(s))
        .filter((i) => i >= 0)
    );
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(applyAt);
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

describe('проверка стоит в обработчике группы до применения', () => {
  const SRC = readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('ban/unban/kick/add/role гасятся раньше switch', () => {
    const at = SRC.indexOf('acceptGroupControlTs(`m:${env.target}`');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(SRC.indexOf('switch (env.op) {'));
  });

  it('«вышел сам» делит знак с составом, а не заводит свой', () => {
    const at = SRC.indexOf('acceptGroupControlTs(`m:${senderPubB64}`');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(SRC.indexOf('removeGroupMember(env.groupId, senderPubB64, pid)'));
  });

  it('каждое поле настроек спрашивает свой знак', () => {
    expect(SRC).toContain("acceptGroupControlTs(`meta:${field}`, env.groupId, pid, env.ts)");
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
  });
});
