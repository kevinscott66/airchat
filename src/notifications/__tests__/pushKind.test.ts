/**
 * v4.32.572. Сообщение в группе доезжает до получателя тем же личным
 * конвертом, что и переписка один на один, и push о нём уходит той же
 * дорогой. При закрытом приложении фоновый обработчик считал его личным:
 * выключатель «Группы» не спрашивался никогда, а «без звука» для человека
 * глушило его сообщения в общей группе.
 */
import fs from 'fs';
import path from 'path';

import { classifyPushKind, parsePushKind } from '../pushKind';

const SRC = path.join(__dirname, '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const MODULE = (): string => read('notifications', 'pushKind.ts');
const PUSH = (): string => read('notifications', 'pushNotifications.ts');
const PREFS = (): string => read('notifications', 'backgroundNotifyPrefs.ts');
const BG = (): string => read('firebaseMessagingBackground.ts');
const MESSAGING = (): string => read('core', 'social', 'messaging.ts');
const GROUPS = (): string => read('core', 'social', 'groupMessaging.ts');

describe('чем было сообщение', () => {
  it('конверт группы — групповой push', () => {
    expect(classifyPushKind('\x02grp:{"gid":"g1","text":"привет"}')).toBe('group');
  });

  it('обычный текст — личный push', () => {
    expect(classifyPushKind('привет')).toBe('dm');
    expect(classifyPushKind('')).toBe('dm');
  });

  it('приглашение, заявка и управление группой едут от человека — они личные', () => {
    expect(classifyPushKind('\x0egctl:{"op":"invite"}')).toBe('dm');
    expect(classifyPushKind('\x0agjr:{"gid":"g1"}')).toBe('dm');
  });

  it('префикс считается только с начала строки', () => {
    expect(classifyPushKind(' \x02grp:{}')).toBe('dm');
    expect(classifyPushKind('текст \x02grp:{}')).toBe('dm');
  });

  it('отсутствие текста не роняет разбор', () => {
    expect(classifyPushKind(null)).toBe('dm');
    expect(classifyPushKind(undefined)).toBe('dm');
    expect(classifyPushKind(42 as unknown as string)).toBe('dm');
  });

  it('копия префикса совпадает с оригиналом из слоя групп', () => {
    expect(GROUPS()).toContain("export const GROUP_MSG_PREFIX = '\\x02grp:';");
    expect(MODULE()).toContain("const GROUP_MSG_PREFIX = '\\x02grp:';");
  });
});

describe('бит из уведомления', () => {
  it('«group» и только он означает группу', () => {
    expect(parsePushKind('group')).toBe('group');
    expect(parsePushKind('dm')).toBe('dm');
  });

  it('старое уведомление без поля считается личным', () => {
    expect(parsePushKind(undefined)).toBe('dm');
    expect(parsePushKind(null)).toBe('dm');
  });

  it('мусор из сети считается личным — там проверок на одну больше', () => {
    for (const raw of ['GROUP', ' group', 'группа', 1, true, {}, []]) {
      expect(parsePushKind(raw)).toBe('dm');
    }
  });
});

describe('бит доезжает от отправителя до фонового обработчика', () => {
  it('отправитель считает вид по телу конверта', () => {
    const s = MESSAGING();
    expect(s).toContain('const pushKind = classifyPushKind(text);');
    expect(s).toContain('sendPushToContact(peerDid, cid, myDid, pushKind)');
  });

  it('вид уезжает в запрос, а идентификатор группы — нет', () => {
    const s = PUSH();
    const at = s.indexOf('private async sendPushNotification(');
    expect(at).toBeGreaterThan(-1);
    const body = s.slice(at, s.indexOf('\n  }\n', at));
    expect(body).toContain('JSON.stringify({ targetPeerId, cid, senderDid, kind })');
    expect(body).not.toContain('groupId');
    expect(body).not.toContain('senderName');
  });

  it('прежний неиспользуемый параметр имени убран', () => {
    expect(PUSH()).not.toContain('_senderName?: string');
    expect(PUSH()).not.toContain('senderDid, _senderName');
  });
});

describe('фоновый обработчик спрашивает выключатель по виду', () => {
  it('вид читается из уведомления до чтения настроек', () => {
    const s = BG();
    const at = s.indexOf('const kind = parsePushKind(remoteMessage.data?.kind);');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(s.indexOf('readBackgroundNotifyPrefs(kind)'));
  });

  it('личное «без звука» к группе не применяется', () => {
    const s = BG();
    expect(s).toContain("if (kind === 'dm' && (await isBackgroundMuted(contactDid))) return;");
  });

  it('каждый вид спрашивает свой ключ', () => {
    const s = PREFS();
    expect(s).toContain("const toggle = kind === 'group' ? 'notify_groups' : 'notify_dm';");
    expect(s).toContain("if (kv.get(toggle) === 'false')");
    expect(s).toContain("'notify_dm','notify_groups','notify_sound'");
    expect(s).not.toContain("if (kv.get('notify_dm') === 'false')");
  });

  it('вид — первый параметр чтения настроек, со значением по умолчанию', () => {
    expect(PREFS()).toContain("kind: PushKind = 'dm',");
  });
});

describe('модуль читает фоновый контекст', () => {
  it('ни одного импорта', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });
});
