/**
 * v4.32.465 — рэтчет: групповой приёмник знает, чей конверт он разбирает.
 *
 * Дефект. Все четыре обработчика входящих групповых конвертов выясняли «кто
 * я» у двух глобальных источников: активного профиля и текущего слота
 * SecureStore (`loadKeyPair()`, который перезаписывается при переключении
 * аккаунта). Конверт при этом расшифрован конкретной парой ключей, а между
 * расшифровкой и этим вопросом стоят await'ы — поиск контакта, ECDH,
 * `refreshSubscriptions()` («это секунды» по комментарию в самом коде).
 *
 * Что ломалось при переключении профиля в это окно: обычное сообщение группы
 * искалось в чужой базе, не находилось и съедалось как `group_msg_unknown_group`
 * навсегда; приглашение заводило группу в чужом аккаунте и писало в участники
 * его ключ — а `groups.id` первичный, поэтому настоящий адресат эту группу уже
 * не заведёт никогда; ответ на собственную заявку сравнивался с чужим ключом и
 * молча выбрасывался.
 *
 * Правка: «кто я» приходит одним значением (GroupRecipient) от службы
 * переписки, которая знает это точно. Тест держит и то, что значение
 * неразъёмное (публичный ключ выводится из пары), и то, что старые источники
 * из приёмного пути ушли.
 */
import * as fs from 'fs';
import * as path from 'path';

import { Buffer } from 'buffer';

import { groupRecipient } from '../groupRecipient';

const HERE = path.join(__dirname, '..');
const GM = fs.readFileSync(path.join(HERE, 'groupMessaging.ts'), 'utf8');
const MSG = fs.readFileSync(path.join(HERE, 'messaging.ts'), 'utf8');
const CONTACTS = fs.readFileSync(path.join(HERE, 'contacts.ts'), 'utf8');
const APP = fs.readFileSync(path.join(HERE, '..', '..', 'App.tsx'), 'utf8');

const count = (h: string, n: string): number => h.split(n).length - 1;

/** В какой функции встречается фрагмент: имена всех объемлющих объявлений. */
function seenIn(source: string, needle: string): string[] {
  const out: string[] = [];
  let fn = '<file>';
  for (const line of source.split('\n')) {
    const head = /^(?:export )?(?:async )?function (\w+)/.exec(line);
    if (head) fn = head[1];
    if (line.includes(needle)) out.push(fn);
  }
  return out;
}

const pairOf = (seed: number) => ({
  publicKey: new Uint8Array(32).fill(seed),
  secretKey: new Uint8Array(64).fill(seed),
});

describe('groupRecipient — значение неразъёмное', () => {
  it('публичный ключ выводится из пары, а не передаётся рядом', () => {
    const pair = pairOf(7);
    expect(groupRecipient(3, pair).myPub).toBe(Buffer.from(pair.publicKey).toString('base64'));
  });

  it('номер профиля сохраняется как передан', () => {
    expect(groupRecipient(42, pairOf(1)).pid).toBe(42);
  });

  it('разные пары дают разный публичный ключ при том же профиле', () => {
    expect(groupRecipient(1, pairOf(1)).myPub).not.toBe(groupRecipient(1, pairOf(2)).myPub);
  });
});

describe('groupMessaging — приёмники больше не спрашивают глобальное', () => {
  it('loadKeyPair из файла ушёл совсем', () => {
    expect(GM).not.toContain('loadKeyPair');
  });

  it('активный профиль остался только на путях отправки', () => {
    // Две оставшиеся точки — проверка права на отправку и сборка приглашения:
    // их зовёт экран, там активный профиль и есть тот, о ком речь.
    expect(seenIn(GM, 'profileManager.getActiveProfile()')).toEqual(['groupSendVerdict', 'sendGroupInvite']);
  });

  it('все четыре обработчика принимают получателя', () => {
    for (const head of [
      'export async function handleIncomingGroupEnvelope(',
      'export async function handleIncomingGroupReadReceipt(',
      'export async function handleIncomingGroupJoinRequest(text: string, rcpt: GroupRecipient,',
      'export async function handleIncomingGroupControl(text: string, rcpt: GroupRecipient,',
    ]) {
      expect(GM).toContain(head);
    }
    expect(count(GM, 'rcpt: GroupRecipient')).toBe(5); // четыре обработчика + isInviteTrusted
  });

  it('решение о доверии к приглашению целиком считается по своему профилю', () => {
    expect(GM).toContain('profileKvGet(rcpt.pid, INVITE_PENDING_KEY_PREFIX + groupId)');
    expect(GM).toContain('listContactsFor(rcpt.pid)');
    expect(GM).toContain("privacyPrefTryBoolFor(rcpt.pid, 'privacy_only_contacts_group')");
    // Общий (непрофильный) маркер не читается и не удаляется.
    expect(GM).not.toContain('kvGet(INVITE_PENDING_KEY_PREFIX');
    expect(GM).not.toContain('kvDelete(INVITE_PENDING_KEY_PREFIX');
    expect(GM).toContain('kvDeleteScoped(pid, INVITE_PENDING_KEY_PREFIX');
  });

  it('разбор заявки считает оба факта по названному профилю', () => {
    expect(GM).toContain('async function joinRequestIntake(requesterPubB64: string, pid: number)');
    expect(count(GM, 'joinRequestIntake(')).toBe(3); // объявление + два пути заявки
    expect(count(GM, ', pid)')).toBeGreaterThanOrEqual(2);
    expect(GM).not.toContain('joinRequestIntake(env.requesterPubB64)');
    expect(GM).not.toContain('joinRequestIntake(senderPubB64)');
  });

  it('отметка о прочтении спрашивает разрешение у того, чей ключ её подпишет', () => {
    expect(GM).not.toContain('readReceiptsAllowed()');
    expect(GM).toContain('readReceiptsAllowedFor((await svc.groupRecipient()).pid)');
  });

  it('прямой транспорт без службы переписки не угадывает профиль, а роняет конверт', () => {
    const lan = GM.slice(GM.indexOf('receiveGroupEnvelope: async'));
    expect(lan).toContain('group_envelope_no_service_drop');
    expect(lan.indexOf('group_envelope_no_service_drop')).toBeLessThan(
      lan.indexOf('await handleIncomingGroupEnvelope(')
    );
    expect(lan).toContain('await svc.groupRecipient()');
  });
});

describe('messaging — получателя строит тот, кто его знает', () => {
  it('все четыре вызова передают его', () => {
    expect(count(MSG, 'await this.groupRecipient(), peerPubKeyB64)')).toBe(4);
  });

  it('строится он из своей пары и своего номера профиля', () => {
    expect(MSG).toContain('return groupRecipient(await this.ownerProfileId(), this.pair);');
  });
});

describe('соседние дома правила', () => {
  it('listContacts стал частным случаем listContactsFor', () => {
    expect(CONTACTS).toContain('return listContactsFor(activeProfileId());');
    expect(CONTACTS).toContain('export async function listContactsFor(ownerProfileId: number)');
  });

  it('маркер «мы сами просились» пишется в свой профиль', () => {
    expect(APP).toContain('profileKvSet(pid, INVITE_PENDING_KEY_PREFIX + payload.id, payload.adminPub)');
    expect(APP).not.toContain('setKv(INVITE_PENDING_KEY_PREFIX');
  });
});

describe('проверка не пустая', () => {
  it('исходники прочитаны', () => {
    for (const src of [GM, MSG, CONTACTS, APP]) expect(src.length).toBeGreaterThan(2000);
  });

  it('seenIn действительно различает функции', () => {
    expect(seenIn(GM, 'export async function handleIncomingGroupControl')).toEqual(['handleIncomingGroupControl']);
    expect(seenIn(GM, 'нет такой строки в файле')).toEqual([]);
  });
});
