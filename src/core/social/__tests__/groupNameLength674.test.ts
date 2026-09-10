/**
 * Название группы мерится одним числом — v4.32.674.
 *
 * groupNameRule написан ради того, чтобы название группы у автора и у всех
 * остальных совпадало, и его собственный докблок говорит: «Те же числа, что у
 * разбора конверта». У 'meta' так и было — OWN_GROUP_NAME_MAX, 128. А
 * приглашение — и конвертом, и ссылкой — меряло название умолчанием
 * sanitizeDisplayName, то есть длиной ИМЕНИ ЧЕЛОВЕКА, 64.
 *
 * Расхождение видно сразу и не выправляется само. Редактор разрешает до 128
 * символов; отправитель кладёт в конверт полное название
 * (normalizeOwnGroupName в groupMessaging); получатель обрезал его вдвое и с
 * этим огрызком заводил у себя группу (createGroup). Следующее 'meta' пришло
 * бы только если название кто-то менял — а до тех пор у автора группа
 * называлась одним, у приглашённых другим. Со ссылкой то же: сборка и разбор
 * резали одинаково, поэтому «ссылка битая» никто и не замечал — просто у
 * пришедшего по ней название было наполовину.
 *
 * Здесь закреплено: название группы — 128 на всех трёх путях, имена людей
 * рядом остаются на 64.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { GROUP_CTL_PREFIX, decodeGroupCtlEnvelope } from '../groupControlEnvelope';
import {
  INVITE_MEMBERS_CAP,
  buildGroupInviteLink,
  parseGroupInviteLink,
} from '../groupInviteLink';
import { OWN_GROUP_NAME_MAX, normalizeOwnGroupName } from '../groupNameRule';
import { sanitizeDisplayName } from '../sysLineGuard';

/** Ed25519-ключ в base64: 32 байта → 44 символа с паддингом. */
const PUB = `${'A'.repeat(43)}=`;
const PUB2 = `${'B'.repeat(43)}=`;
/** Заведомо длиннее обоих потолков. */
const LONG = 'я'.repeat(400);

const BASE = { groupId: 'g1', ts: 1_700_000_000_000 };
const enc = (env: Record<string, unknown>): string => GROUP_CTL_PREFIX + JSON.stringify(env);

type Env = Record<string, unknown> | null;

const invite = (over: Record<string, unknown> = {}): Env =>
  decodeGroupCtlEnvelope(
    enc({ ...BASE, op: 'invite', groupName: 'Наши', members: [{ pub: PUB, name: 'Аня' }], ...over })
  ) as Env;

const meta = (over: Record<string, unknown> = {}): Env =>
  decodeGroupCtlEnvelope(enc({ ...BASE, op: 'meta', ...over })) as Env;

const linkBase = {
  id: 'g-1',
  name: 'Команда',
  type: 'group' as const,
  adminPub: PUB,
  requireApproval: false,
  members: [{ peerPubB64: PUB2, displayName: 'Аня' }],
};

const viaLink = (over: Partial<typeof linkBase> = {}) =>
  parseGroupInviteLink(buildGroupInviteLink({ ...linkBase, ...over }));

/** Исходник без строк-комментариев: докблоки цитируют сам разбираемый дефект. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}
const MESSAGING_RAW = readFileSync(join(__dirname, '..', 'groupMessaging.ts'), 'utf8');
const MESSAGING = codeOnly(MESSAGING_RAW);

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('своё название по-прежнему разрешено длиннее имени человека', () => {
    // Если бы редактор сам резал до 64, резать на приёме было бы нечего.
    expect(normalizeOwnGroupName(LONG)).toHaveLength(OWN_GROUP_NAME_MAX);
    expect(OWN_GROUP_NAME_MAX).toBeGreaterThan(64);
  });

  it('отправитель кладёт в приглашение полное название', () => {
    expect(MESSAGING).toMatch(
      /groupName: normalizeOwnGroupName\(groupName\) \|\| FALLBACK_GROUP_NAME,/
    );
  });

  it('получатель заводит группу именно этим названием', () => {
    expect(MESSAGING).toMatch(/createGroup\(env\.groupId, pid, env\.groupName,/);
  });

  it('имя человека мерится своим, коротким числом', () => {
    // Это и есть то умолчание, которым по ошибке мерилось название группы.
    expect(sanitizeDisplayName(LONG)).toHaveLength(64);
  });
});

describe('название группы — 128 на всех путях', () => {
  it('конверт-приглашение больше не режет название вдвое', () => {
    expect(invite({ groupName: LONG })?.groupName).toHaveLength(OWN_GROUP_NAME_MAX);
  });

  it('«переименовать» и «пригласить» дают одно и то же название', () => {
    for (const n of [LONG, 'Наши ребята', 'Клуб‮exe.pdf', 'я'.repeat(100), 'Отдел']) {
      expect([n, invite({ groupName: n })?.groupName]).toEqual([n, meta({ name: n })?.name]);
    }
  });

  it('ссылка приглашения тоже несёт название целиком', () => {
    expect(viaLink({ name: LONG })?.name).toHaveLength(OWN_GROUP_NAME_MAX);
  });

  it('длинное название не выталкивает ссылку за её потолок', () => {
    // Потолок base64 — INVITE_B64_MAX; лишние 64 символа не должны превращать
    // полное приглашение в неразбираемое.
    const many = Array.from({ length: INVITE_MEMBERS_CAP }, (_, i) => ({
      peerPubB64: Buffer.alloc(32, i + 3).toString('base64'),
      displayName: `Участник ${i}`,
    }));
    expect(viaLink({ name: LONG, members: many })?.members).toHaveLength(INVITE_MEMBERS_CAP);
  });
});

describe('имена людей рядом остались на 64', () => {
  it('в конверте приглашения', () => {
    const members = invite({ members: [{ pub: PUB, name: LONG }] })?.members as
      | Array<{ name: string }>
      | undefined;
    expect(members?.[0]?.name).toHaveLength(64);
  });

  it('в ссылке приглашения', () => {
    const parsed = viaLink({ members: [{ peerPubB64: PUB2, displayName: LONG }] });
    expect(parsed?.members?.[0]?.name).toHaveLength(64);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходник отправителя прочитан', () => {
    expect(MESSAGING_RAW.length).toBeGreaterThan(90_000);
    // И фильтр комментариев не съел сам код.
    expect(MESSAGING.length).toBeGreaterThan(40_000);
  });

  it('обычное короткое название проходит все три пути без изменений', () => {
    expect(meta({ name: 'Наши' })?.name).toBe('Наши');
    expect(invite({ groupName: 'Наши' })?.groupName).toBe('Наши');
    expect(viaLink({ name: 'Наши' })?.name).toBe('Наши');
  });
});
