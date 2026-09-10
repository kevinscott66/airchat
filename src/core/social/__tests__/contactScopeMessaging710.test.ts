import fs from 'fs';
import path from 'path';

/**
 * v4.32.710: служба сообщений спрашивает контакты у СВОЕГО профиля.
 *
 * `MessagingService` работает одной парой ключей и знает своего владельца
 * (`ownerProfileId()`, публичный с v4.32.470, ответ запомнен). Но четыре места
 * в файле спрашивали контакты у `listContacts()`, то есть у
 * `listContactsFor(activeProfileId())` — у того профиля, чей экран открыт
 * прямо сейчас. Между переключением аккаунта и этими четырьмя вопросами стоят
 * ожидания сети, так что «активный» и «владелец» расходятся не в теории:
 *
 *  — `findContactPubKeyByDid` (приём личного конверта): свой контакт выглядел
 *    незнакомцем, и при включённом «сообщения только от контактов» его письмо
 *    отбрасывалось молча и навсегда (`dm_rejected_non_contact`);
 *  — `gossipDmToContacts`: конверт с открытым `recipientDid` уезжал по чужой
 *    записной книжке — связка двух аккаунтов одного человека для их общих
 *    знакомых, и мост через общего контакта переставал работать;
 *  — `startListening`: подписка на топики чужих собеседников вместо своих;
 *  — `handlePushOpen`: сообщение из уведомления не подгружалось
 *    (`push_no_contact_for_did`).
 *
 * Правило и его формулировка уже есть в `listContactsFor` (v4.32.465):
 * «активный» — это про экран, а не про работу.
 *
 * Проверка идёт по исходнику, а не через импорт: `messaging.ts` тянет `uuid`,
 * который приходит как ESM и не проходит трансформацию jest (тот же довод, что
 * в `scheduledOwnerDelete662.test.ts`).
 */

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const MSG = () => read('core', 'social', 'messaging.ts');
const CONTACTS = () => read('core', 'social', 'contacts.ts');

/** Только код: строки комментариев не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

/** Кусок исходника от начала функции до её опознавательного конца. */
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(end, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe('контакты берутся у владельца службы', () => {
  it('в messaging.ts не осталось ни одного вызова listContacts()', () => {
    const code = codeOnly(MSG());
    expect(code.match(/\blistContacts\(/g)).toBeNull();
    expect(code).toContain("import { getSymmetricKeyForPeer, listContactsFor,");
  });

  it('все четыре чтения перешли на listContactsFor', () => {
    const code = codeOnly(MSG());
    expect(code.match(/\blistContactsFor\(/g)?.length).toBe(4);
  });

  it('findContactPubKeyByDid получает профиль параметром, а не берёт активный', () => {
    const code = codeOnly(MSG());
    expect(code).toContain(
      'async function findContactPubKeyByDid(did: string, ownerProfileId: number): Promise<string | null> {'
    );
    expect(code).toContain('const contacts = await listContactsFor(ownerProfileId);');
    expect(countOf(code, 'findContactPubKeyByDid(')).toBe(2);
    expect(code).toContain(
      'await findContactPubKeyByDid(em.senderDid, await this.ownerProfileId())'
    );
  });

  it('веер, подписки и пуш спрашивают у this.ownerProfileId()', () => {
    const code = codeOnly(MSG());
    const gossip = between(code, 'private async gossipDmToContacts(', 'dm_gossip_failed');
    const listen = between(code, 'async startListening(): Promise<void> {', 'subscribedCount === 0');
    const push = between(code, 'async handlePushOpen(', 'push_no_contact_for_did');
    for (const body of [gossip, listen, push]) {
      expect(body).toContain('await listContactsFor(await this.ownerProfileId())');
    }
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  it('потолок веера и его след в журнале на месте', () => {
    const code = codeOnly(MSG());
    expect(code).toContain('private static readonly GOSSIP_FANOUT_LIMIT = 64;');
    expect(code).toContain('if (sent >= MessagingService.GOSSIP_FANOUT_LIMIT) break;');
    expect(code).toContain("log.info('dm_gossip_fanout_capped'");
    expect(code).toContain("log.warn('dm_gossip_failed'");
  });

  it('поколение подписок и повтор при нулевой подписке не тронуты', () => {
    const code = codeOnly(MSG());
    const listen = between(code, 'async startListening(): Promise<void> {', 'subscribedCount === 0');
    expect(listen).toContain('const stillFresh = (): boolean => this.subGen === gen;');
    expect(listen).toContain('if (!stillFresh()) return;');
    expect(listen).toContain("log.warn('subscribe_bad_contact_pub');");
    expect(code).toContain('if (subscribedCount === 0 && contacts.length > 0) {');
  });

  it('пуш по-прежнему загружает сообщение и жалуется, если пира нет', () => {
    const code = codeOnly(MSG());
    const push = between(code, 'async handlePushOpen(', '}\n}');
    expect(push).toContain('await this.receiveCid(cid.trim(), c.peerPublicKey);');
    expect(push).toContain("log.warn('push_missing_contact_did');");
    expect(push).toContain("log.warn('push_no_contact_for_did'");
  });

  it('приём личного конверта сохранил прежние ключи и неявный контакт', () => {
    const code = codeOnly(MSG());
    expect(code).toContain('sym = deriveSymmetricKeyForStranger(this.pair, senderPk);');
    expect(code).toContain(
      'sym = await getSymmetricKeyForPeer(await this.ownerProfileId(), peerPubKeyB64);'
    );
    expect(code).toContain(
      'await ensureImplicitContact(await this.ownerProfileId(), this.pair, senderPk)'
    );
    expect(code).toContain("log.warn('contact_find_did_failed'");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('listContacts() в contacts.ts всё ещё про активный профиль', () => {
    const contacts = CONTACTS();
    expect(codeOnly(contacts)).toContain('return listContactsFor(activeProfileId());');
    expect(contacts).toContain(
      'export async function listContactsFor(ownerProfileId: number): Promise<Contact[]> {'
    );
    expect(contacts).toContain('«Активный» — это про экран, а не про работу');
  });

  it('незнакомцем считается тот, кого не нашли в контактах, и его письмо могут отбросить', () => {
    const code = codeOnly(MSG());
    const found = code.indexOf('await findContactPubKeyByDid(em.senderDid');
    const stranger = code.indexOf('needsImplicitContact = true;');
    const dropped = code.indexOf("log.info('dm_rejected_non_contact'");
    expect(found).toBeGreaterThan(-1);
    expect(stranger).toBeGreaterThan(found);
    expect(dropped).toBeGreaterThan(stranger);
    expect(code).toContain("await privacyPrefTryBoolFor(");
  });

  it('владелец службы известен точно и запоминается', () => {
    const code = codeOnly(MSG());
    expect(code).toContain('async ownerProfileId(): Promise<number> {');
    expect(code).toContain('if (this.ownerPid !== null) return this.ownerPid;');
    expect(code).toContain('return ownerPidByDid(');
  });
});
