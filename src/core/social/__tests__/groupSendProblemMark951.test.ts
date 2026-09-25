/**
 * Сообщение, которое не ушло никому, больше не выглядит отправленным (v4.32.951).
 *
 * Дефект. Своя строка в группе пишется в базу ДО рассылки — иначе собственное
 * сообщение не появилось бы на собственном экране. Исход рассылки с v4.32.450
 * разбирается и называется вслух, но живёт этот ответ ровно столько, сколько
 * висит всплывающая плашка. Дальше оставались два утверждения, ничем не
 * подкреплённые: под сообщением стояла ДВОЙНАЯ галочка (в общем языке
 * переписок — «доставлено»), а в окне сведений было написано «Отправлено».
 *
 * Двойная галочка бралась не из доставки, а из порядка: одна галочка
 * доставалась последнему отправленному за этот заход сообщению, всем
 * остальным — двойная. То есть стоило написать следующее сообщение, как
 * предыдущее «доставлялось», даже если рассылка его провалилась.
 *
 * Цена. Забаненный, переведённый в «только чтение» или оставшийся без связи
 * видит свои сообщения в группе с отметкой доставки и не понимает, почему
 * никто не отвечает. Повтора у групповых сообщений нет — значит, единственное,
 * что вообще можно сделать, это сказать правду и не потерять её через минуту.
 *
 * Правка. Отметка о несостоявшейся рассылке кладётся в запись профиля
 * (groupSendProblemStore, шифртекстом) и переживает выход из группы. Значок
 * под сообщением говорит только известное: «не отправлено» по отметке,
 * «прочитано» по квитанциям, иначе «отправлено». Окно сведений при отметке
 * пишет «Создано» и называет причину целой фразой.
 *
 * Границы. «Доставлено» в группе не рисуется вовсе и рисоваться не может:
 * подтверждения доставки у группового конверта нет ни у кого — есть только
 * прочтение. Строка по-прежнему ложится до рассылки, и это правильно: иначе
 * отправитель не видел бы собственного сообщения, пока не ответит последний
 * из девятнадцати.
 */
import fs from 'fs';
import path from 'path';

const mockKv = new Map<string, string>();
/** Ключи, чтение которых база не выполняет. */
const mockFailReads = new Set<string>();
/** Ключи, запись которых база не выполняет. */
const mockFailWrites = new Set<string>();
let mockNotified = 0;

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGetSecretFor: async (pid: number, key: string) => {
    const k = `p${pid}:${key}`;
    if (mockFailReads.has(k)) return null;
    return { value: mockKv.get(k) ?? null };
  },
  scopedKvSetSecretCheckedFor: async (pid: number, key: string, value: string) => {
    const k = `p${pid}:${key}`;
    if (mockFailWrites.has(k)) return false;
    mockKv.set(k, value);
    return true;
  },
}));
jest.mock('../../storage/local', () => ({
  notifyChatStorageChanged: () => {
    mockNotified += 1;
  },
}));
jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import {
  loadGroupSendProblemsFor,
  recordGroupSendProblemFor,
  forgetGroupSendProblemsFor,
} from '../groupSendProblemStore';
import type { GroupSendProblem } from '../groupSendOutcome';

const PID = 3;
const DB_KEY = 'p3:groups:send_problems';
const NO_ONE: GroupSendProblem = { kind: 'undelivered', reason: 'all_failed' };
const PARTIAL: GroupSendProblem = { kind: 'partial', sent: 1, members: 19 };

const root = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(root, ...p), 'utf8');
const GROUPS = read('ui', 'screens', 'GroupsScreen.tsx');
const ANNOUNCE = read('ui', 'groupSendAnnounce.ts');
const INFO_MODAL = read('ui', 'components', 'modals', 'groups', 'GroupMessageInfoModal.tsx');
const ICON = read('ui', 'screens', 'chat-components', 'GroupMessageStatusIcon.tsx');
const OUTCOME = read('core', 'social', 'groupSendOutcome.ts');
const DM_MODAL = read('ui', 'components', 'modals', 'chat', 'ChatMessageInfoModal.tsx');

beforeEach(() => {
  mockKv.clear();
  mockFailReads.clear();
  mockFailWrites.clear();
  mockNotified = 0;
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: отметка кладётся и читается', () => {
  it('записанная отметка возвращается чтением', async () => {
    expect(await recordGroupSendProblemFor(PID, 'msg-1', NO_ONE)).toBe(true);
    const map = await loadGroupSendProblemsFor(PID);
    expect(map?.['msg-1']?.problem).toEqual(NO_ONE);
    expect(typeof map?.['msg-1']?.at).toBe('number');
  });

  it('у чистого профиля отметок нет, и это не отказ чтения', async () => {
    expect(await loadGroupSendProblemsFor(PID)).toEqual({});
  });

  it('исходники на месте', () => {
    expect(GROUPS.length).toBeGreaterThan(100000);
    expect(ANNOUNCE.length).toBeGreaterThan(1000);
    expect(ICON.length).toBeGreaterThan(1000);
  });
});

describe('карта отметок ведёт себя как карта «кому уже сказано»', () => {
  it('вторая отметка не затирает первую', async () => {
    await recordGroupSendProblemFor(PID, 'msg-1', NO_ONE);
    await recordGroupSendProblemFor(PID, 'msg-2', PARTIAL);
    const map = await loadGroupSendProblemsFor(PID);
    expect(Object.keys(map ?? {}).sort()).toEqual(['msg-1', 'msg-2']);
    expect(map?.['msg-2']?.problem).toEqual(PARTIAL);
  });

  it('не прочитали — не пишем', async () => {
    await recordGroupSendProblemFor(PID, 'msg-1', NO_ONE);
    const before = mockKv.get(DB_KEY);
    mockFailReads.add(DB_KEY);
    expect(await recordGroupSendProblemFor(PID, 'msg-2', NO_ONE)).toBe(false);
    // Прежняя карта на месте: одна свежая отметка не выдала себя за весь список.
    expect(mockKv.get(DB_KEY)).toBe(before);
  });

  it('отказ чтения отличим от пустоты', async () => {
    mockFailReads.add(DB_KEY);
    expect(await loadGroupSendProblemsFor(PID)).toBeNull();
  });

  it('отказ записи не выдаётся за удачу', async () => {
    mockFailWrites.add(DB_KEY);
    expect(await recordGroupSendProblemFor(PID, 'msg-1', NO_ONE)).toBe(false);
    expect(mockNotified).toBe(0);
  });

  it('удачная запись будит экран группы', async () => {
    await recordGroupSendProblemFor(PID, 'msg-1', NO_ONE);
    expect(mockNotified).toBe(1);
  });

  it('карта не растёт без предела, и лишними уходят самые старые', async () => {
    for (let i = 0; i < 205; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await recordGroupSendProblemFor(PID, `m${i}`, NO_ONE);
    }
    const map = (await loadGroupSendProblemsFor(PID)) ?? {};
    expect(Object.keys(map)).toHaveLength(200);
    expect(map['m204']).toBeDefined();
    expect(map['m0']).toBeUndefined();
  });

  it('битая и чужая запись не роняет карту целиком', async () => {
    mockKv.set(DB_KEY, JSON.stringify({ ok: { at: 1, problem: NO_ONE }, bad: { at: 'вчера' }, junk: 5 }));
    const map = await loadGroupSendProblemsFor(PID);
    expect(Object.keys(map ?? {})).toEqual(['ok']);
  });

  it('удалённое сообщение забывает свою отметку', async () => {
    await recordGroupSendProblemFor(PID, 'msg-1', NO_ONE);
    await recordGroupSendProblemFor(PID, 'msg-2', NO_ONE);
    await forgetGroupSendProblemsFor(PID, ['msg-1']);
    expect(Object.keys((await loadGroupSendProblemsFor(PID)) ?? {})).toEqual(['msg-2']);
  });
});

describe('воронка показа не только говорит, но и запоминает', () => {
  it('исход рассылки кладётся рядом с сообщением', () => {
    expect(ANNOUNCE).toContain('if (problem) showError(groupSendProblemText(problem));');
    expect(ANNOUNCE).toContain('if (problem) void recordGroupSendProblemFor(sent.pid, sent.msgId, problem);');
  });

  it('профиль называется вызывающим, а не спрашивается у активного', () => {
    expect(ANNOUNCE).toContain('export type GroupSentMessage = { msgId: string; pid: number };');
    expect(ANNOUNCE).not.toContain('activeProfileId');
  });

  it('сорвавшаяся рассылка — тоже «не ушло никому»', () => {
    expect(ANNOUNCE).toContain("kind: 'undelivered',");
    expect(ANNOUNCE).toContain("reason: 'all_failed',");
  });

  it('все места отправки называют своё сообщение', () => {
    const FEED = read('ui', 'screens', 'FeedScreen.tsx');
    let calls = 0;
    for (const src of [GROUPS, FEED]) {
      for (const line of src.split('\n')) {
        if (!line.includes('announceGroupSend(')) continue;
        if (line.trim().startsWith('*') || line.includes('import')) continue;
        calls += 1;
      }
      // Однострочные вызовы несут пару прямо в себе; единственный перенесённый
      // отдаёт её отдельной строкой.
      const single = (src.match(/announceGroupSend\(fanoutGroupMessage\(/g) ?? []).length;
      const paired = (src.match(/\{ msgId: row\.id, pid \}/g) ?? []).length;
      expect(paired).toBeGreaterThanOrEqual(single);
    }
    expect(calls).toBeGreaterThanOrEqual(11);
  });
});

describe('значок под своим сообщением говорит только известное', () => {
  it('«доставлено» в группе не рисуется', () => {
    // Значок сообщения теперь один на все состояния и живёт отдельным файлом;
    // в самом экране остаётся только его вызов. Двойная пустая галочка —
    // «Доставлено» на языке MessageStatusIcon — из него ушла.
    expect(ICON).not.toContain('checkmark-done-outline');
    expect(GROUPS).toContain('<GroupMessageStatusIcon');
  });

  it('галочка больше не зависит от того, какое сообщение написано последним', () => {
    expect(GROUPS).not.toContain('lastSentMsgIdRef');
  });

  it('три состояния и у каждого имя для озвучки', () => {
    expect(ICON).toContain("accessibilityLabel={`Не отправлено: ${groupSendProblemShort(problem)}`}");
    expect(ICON).toContain('accessibilityLabel="Прочитано"');
    expect(ICON).toContain('accessibilityLabel="Отправлено"');
    expect(ICON).toContain('if (seenCount > 0) {');
  });

  it('экран отдаёт значку отметку и число прочитавших', () => {
    expect(GROUPS).toContain('problem={sendProblems[item.id]?.problem ?? null}');
    expect(GROUPS).toContain('seenCount={item.seenBy?.length ?? 0}');
  });

  it('нечитаемая карта не выдаётся за «отказов нет»', () => {
    expect(GROUPS).toContain('if (problems) setSendProblems(problems);');
    expect(GROUPS).not.toContain('setSendProblems(problems ?? {})');
  });
});

describe('окно сведений: слово «Отправлено» стало условным', () => {
  it('при отметке окно пишет «Создано» и называет причину', () => {
    expect(INFO_MODAL).toContain("{problem ? 'Создано' : 'Отправлено'}");
    expect(INFO_MODAL).toContain('{groupSendProblemText(problem)}');
  });

  it('экран передаёт окну отметку именно этого сообщения', () => {
    expect(GROUPS).toContain('problem={grpMsgInfoTarget ? (sendProblems[grpMsgInfoTarget.id]?.problem ?? null) : null}');
  });

  it('слово взято у личной переписки, а не выдумано здесь', () => {
    // В ChatMessageInfoModal ровно та же развилка стоит с тех пор, как у
    // личного сообщения появилось состояние.
    expect(DM_MODAL).toContain("{leftDevice ? 'Отправлено' : 'Создано'}");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строка по-прежнему ложится до рассылки — потому отметка и нужна', () => {
    const insert = GROUPS.indexOf('await insertGroupMessageOrThrow(row);');
    const fanout = GROUPS.indexOf('announceGroupSend(');
    expect(insert).toBeGreaterThan(0);
    expect(fanout).toBeGreaterThan(insert);
  });

  it('повтора у групповых сообщений так и нет', () => {
    expect(OUTCOME).toContain('повтора у групповых сообщений нет');
    expect(OUTCOME).toContain("if (res.sent < res.members) return { kind: 'partial', sent: res.sent, members: res.members };");
  });

  it('в личной переписке значок остался своим, со своими состояниями', () => {
    const dmIcon = read('ui', 'screens', 'chat-components', 'MessageStatusIcon.tsx');
    expect(dmIcon).toContain("case 'delivered':");
    expect(dmIcon).toContain('accessibilityLabel="Доставлено"');
  });
});
