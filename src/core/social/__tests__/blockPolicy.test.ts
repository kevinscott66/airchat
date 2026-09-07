/**
 * Блокировка глушит собеседника целиком, а не только текст (v4.32.491).
 *
 * Проверка блок-листа в личке стояла в двух местах: перед показом «печатает…»
 * и перед сохранением текстовой строки. Между расшифровкой конверта и этой
 * проверкой лежала вся диспетчеризация служебных конвертов, и каждый из них
 * применялся к базе безусловно. Заблокированный человек не появлялся на
 * экране — и при этом включал мне исчезающие сообщения (вместе с видимой
 * системной строкой и стиранием переписки), ставил реакции, менял
 * закреплённое сообщение, переписывал своё имя, фото и «О себе» в моих
 * контактах, клал сторис в мою ленту, голосовал в опросах и закрывал их.
 *
 * Исключение оставлено намеренно: конверты, адресованные группе. Мой личный
 * список — про личку. Выбросить `\x0egctl:` от заблокированного
 * администратора значит навсегда разойтись с группой в составе и правах, и
 * починить это будет нечем.
 */
import * as fs from 'fs';
import * as path from 'path';

import { GROUP_SCOPED_PREFIXES, survivesBlock } from '../blockPolicy';

const DIR = path.join(__dirname, '..');

function src(rel: string): string {
  return fs.readFileSync(path.join(DIR, rel), 'utf8');
}

/** Значение `export const NAME = '…'` прямо из исходника, без импорта модуля. */
function constFromSource(file: string, name: string): string {
  const m = new RegExp(`export const ${name} = '([^']*)'`).exec(src(file));
  if (!m) throw new Error(`не найден ${name} в ${file}`);
  return m[1].replace(/\\x([0-9a-fA-F]{2})/g, (_s, h: string) => String.fromCharCode(parseInt(h, 16)));
}

describe('что переживает блокировку', () => {
  it.each(GROUP_SCOPED_PREFIXES.map((p) => [JSON.stringify(p), p] as const))(
    'конверт группы %s доходит: состояние группы задаётся её ролями',
    (_label, prefix) => {
      expect(survivesBlock(`${prefix}{"a":1}`)).toBe(true);
    },
  );

  const personal: Array<[string, string, string]> = [
    ['реакция', 'reactionEnvelope.ts', 'REACTION_PREFIX'],
    ['голос в опросе', 'pollVoteEnvelope.ts', 'POLL_VOTE_PREFIX'],
    ['закрытие опроса', 'pollVoteEnvelope.ts', 'POLL_CLOSE_PREFIX'],
    ['просьба скрыть время входа', 'presenceEnvelope.ts', 'PRESENCE_PREF_PREFIX'],
    ['сторис', 'storyEnvelope.ts', 'STORY_PREFIX'],
    ['таймер исчезающих сообщений', 'disappearEnvelope.ts', 'DISAPPEAR_PREFIX'],
    ['имя и фото собеседника', 'profileEnvelope.ts', 'PROFILE_PREFIX'],
    ['закрепление в личке', 'dmPinEnvelope.ts', 'DM_PIN_PREFIX'],
  ];

  it.each(personal)('%s блокировку не переживает', (_label, file, name) => {
    expect(survivesBlock(`${constFromSource(file, name)}{"a":1}`)).toBe(false);
  });

  it('обычный текст блокировку не переживает', () => {
    expect(survivesBlock('привет')).toBe(false);
  });

  it('живая геолокация блокировку не переживает', () => {
    expect(survivesBlock('\x0cliveloc:55.7,37.6')).toBe(false);
  });

  it('служебный payload без текста блокировку не переживает', () => {
    expect(survivesBlock(undefined)).toBe(false);
    expect(survivesBlock(null)).toBe(false);
    expect(survivesBlock(42)).toBe(false);
    expect(survivesBlock('')).toBe(false);
  });

  it('похожий, но не тот префикс не проходит', () => {
    expect(survivesBlock('\x02grpX:{}')).toBe(false);
    expect(survivesBlock(' \x02grp:{}')).toBe(false);
  });
});

describe('префиксы совпадают с объявленными у обработчиков', () => {
  it.each([
    ['groupMessaging.ts', 'GROUP_READ_RECEIPT_PREFIX'],
    ['groupMessaging.ts', 'GROUP_JOIN_REQUEST_PREFIX'],
    ['groupControlEnvelope.ts', 'GROUP_CTL_PREFIX'],
  ])('%s:%s — в списке blockPolicy', (file, name) => {
    expect([...GROUP_SCOPED_PREFIXES]).toContain(constFromSource(file, name));
  });

  it('префикс группового сообщения совпадает с диспетчером в messaging.ts', () => {
    expect(src('messaging.ts')).toContain("startsWith('\\x02grp:')");
    expect([...GROUP_SCOPED_PREFIXES]).toContain('\x02grp:');
  });

  it('модуль ни от чего не зависит: обработчики тянут за собой базу', () => {
    expect(src('blockPolicy.ts')).not.toMatch(/^\s*import\s/m);
  });
});

describe('форма исходников: проверка стоит до диспетчеризации', () => {
  const text = src('messaging.ts');
  const at = (needle: string): number => {
    const i = text.indexOf(needle);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  };

  // v4.32.615: мест стало два, и это не размывание правила, а его вторая
  // половина. Нижнее решает, применять ли содержимое конверта; верхнее — за-
  // водить ли строку контакта, потому что она создаётся ещё до нижнего, и
  // заблокированный возвращался в список от одного своего сообщения.
  const PERSIST_GATE = (): number => text.lastIndexOf('rateLimiter.isBlocked(peerPubKeyB64)');
  const CONTACT_GATE = (): number => text.indexOf('rateLimiter.isBlocked(peerPubKeyB64)');

  it('блок-лист спрашивается ровно в двух местах, и оба известны', () => {
    const hits = text.split('rateLimiter.isBlocked(peerPubKeyB64)').length - 1;
    expect(hits).toBe(2);
    expect(CONTACT_GATE()).toBeLessThan(PERSIST_GATE());
    expect(text.slice(CONTACT_GATE(), PERSIST_GATE())).toContain('dm_blocked_no_implicit_contact');
    expect(text.slice(PERSIST_GATE())).toContain('dm_blocked_drop');
  });

  it('строку контакта заблокированному не заводят', () => {
    expect(CONTACT_GATE()).toBeLessThan(at('await ensureImplicitContact('));
  });

  it('обе проверки идут после готовности блок-листа', () => {
    // Пока список поднимается с диска, isBlocked отвечает «не заблокирован»
    // на кого угодно (v4.32.317), поэтому каждой проверке обязано
    // предшествовать своё ожидание готовности.
    for (const gate of [CONTACT_GATE(), PERSIST_GATE()]) {
      expect(text.lastIndexOf('await rateLimiter.whenReady()', gate)).toBeGreaterThanOrEqual(0);
    }
  });

  it('и до применения служебных конвертов', () => {
    const gate = PERSIST_GATE();
    for (const marker of [
      "payload.kind === 'delete'",
      "payload.kind === 'edit'",
      "payload.kind === 'read_receipt'",
      "payload.kind === 'typing'",
      'handleIncomingStory',
      'handleIncomingReaction',
      'handleIncomingPollVote',
      'handleIncomingPollClose',
      'handleIncomingDmPin',
      'handleIncomingDisappear',
      'handleIncomingLastSeenPref',
      'handleIncomingPeerProfile',
      'if (inbound && liveNext) {',
      'await saveChatMessage(row)',
    ]) {
      expect(at(marker)).toBeGreaterThan(gate);
    }
  });

  it('исключение для групп проходит через blockPolicy, а не через список на месте', () => {
    expect(text).toContain("import { survivesBlock } from './blockPolicy'");
    const lines = text.split('\n');
    const gates = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('rateLimiter.isBlocked(peerPubKeyB64)'));
    expect(gates).toHaveLength(2);
    // v4.32.617: верхняя проверка перестала быть однострочной — заблокированный
    // с групповым конвертом идёт дальше, но строку контакта не заводит. Поэтому
    // `survivesBlock` ищется в теле проверки, а не строго в её первой строке.
    for (const { i } of gates) {
      expect(lines.slice(i, i + 4).join('\n')).toContain('survivesBlock');
    }
    // Нижняя проверка отделяет входящее от своего же исходящего; верхняя стоит
    // на пути, где своих конвертов не бывает по определению, — там незнакомец.
    expect(gates.some(({ l }) => l.includes('inbound'))).toBe(true);
  });
});
