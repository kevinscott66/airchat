/**
 * v4.32.724: «справочник не прочитался» перестало значить «контактов нет».
 *
 * Дефект. `listContactsFor` сводит оба случая в пустой массив — и это верно
 * там, где нужен ответ на вопрос «в контактах ли он», а не диагноз. Но три
 * места делали из пустоты вывод, который при сорванном чтении оборачивался
 * потерей:
 *
 *  — `startListening`: пустой список означал «подписываться не на кого», и
 *    проверка `subscribedCount === 0 && contacts.length > 0` не возвращала
 *    `listening` в false. Служба считала себя слушающей, не подписавшись ни на
 *    один топик: тишина до перезапуска приложения при живой сети;
 *  — `findContactPubKeyByDid` (приём личного конверта по локальной сети): свой
 *    контакт выглядел незнакомцем. Ветка незнакомца берёт другую формулу
 *    ключа, письмо своего же контакта ею не расшифровывается — и уходит в
 *    корзину как чужой мусор, молча и навсегда;
 *  — публикация сторис (проверена поимённо в `storyPublishDelivery.test.ts`):
 *    ноль контактов вместо диагноза, и автор не слышал ни слова о сторис,
 *    которую не получил никто.
 *
 * Тот же разлад и та же развязка, что у `listGroupMembersRead` (v4.32.648) и
 * `groupSendOutcome` (v4.32.700): решения, которым отказ дороже пустоты, берут
 * различающее чтение и отвечают на null отдельной веткой.
 *
 * Проверка идёт по исходнику: `messaging.ts` тянет `uuid`, который приходит
 * как ESM и не проходит трансформацию jest (тот же довод, что в
 * `contactScopeMessaging710.test.ts`). Текст автору сторис проверен вживую —
 * `storyPublishOutcome` чистый, его можно позвать.
 */

import fs from 'fs';
import path from 'path';

import { storyPublishProblem } from '../storyPublishOutcome';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** Только код: комментарии не должны сами удовлетворять проверку. */
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const MSG = codeOnly(read('messaging.ts'));

/** Кусок исходника от начала до опознавательного конца. */
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(end, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe('подписка на топики: молчание больше не выдаётся за слух', () => {
  const LISTEN = between(MSG, 'async startListening(): Promise<void> {', 'subscribedCount === 0');

  it('список берётся различающим чтением', () => {
    expect(LISTEN).toContain('const contacts = await listContactsReadFor(await this.ownerProfileId());');
  });

  it('на отказ чтения служба снимает с себя признак слушающей', () => {
    const guard = LISTEN.indexOf('if (contacts === null) {');
    expect(guard).toBeGreaterThan(-1);
    const tail = LISTEN.slice(guard);
    expect(tail).toContain("log.warn('subscribe_contacts_unreadable');");
    expect(tail).toContain('this.listening = false;');
    // Выход именно здесь: иначе цикл ниже пошёл бы по null.
    expect(tail.indexOf('return;')).toBeGreaterThan(tail.indexOf('this.listening = false;'));
  });

  it('проверка свежести поколения стоит до решения', () => {
    const fresh = LISTEN.indexOf('if (!stillFresh()) return;');
    const guard = LISTEN.indexOf('if (contacts === null) {');
    expect(fresh).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(fresh);
  });
});

describe('личный конверт: неизвестность не выдаётся за незнакомца', () => {
  it('у поиска по DID три ответа, а не два', () => {
    expect(MSG).toContain("type ContactLookup = string | null | 'unreadable';");
    expect(MSG).toContain(
      'async function findContactPubKeyByDid(did: string, ownerProfileId: number): Promise<ContactLookup> {'
    );
  });

  it('и сорванное чтение, и исключение отвечают одинаково', () => {
    const body = between(MSG, 'async function findContactPubKeyByDid(', '\n}');
    expect(body).toContain('const contacts = await listContactsReadFor(ownerProfileId);');
    expect(body).toContain("if (contacts === null) return 'unreadable';");
    // Ветка catch раньше отвечала null — то есть «незнакомец».
    expect(body).toContain("log.warn('contact_find_did_failed'");
    expect((body.match(/return 'unreadable';/g) ?? []).length).toBe(2);
    expect(body).toContain('return null;');
  });

  it('конверт откладывают до ветки незнакомца, а не после неё', () => {
    const call = MSG.indexOf('const lookup = await findContactPubKeyByDid(em.senderDid');
    const guard = MSG.indexOf("if (lookup === 'unreadable') {", call);
    const stranger = MSG.indexOf('needsImplicitContact = true;', call);
    expect(call).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(call);
    expect(stranger).toBeGreaterThan(guard);
    const inside = MSG.slice(guard, stranger);
    expect(inside).toContain("log.warn('lan_contacts_unreadable_envelope_left'");
    expect(inside.indexOf('return;')).toBeGreaterThan(-1);
  });

  it('дальше по коду ответ уже обычный: строка или null', () => {
    expect(MSG).toContain('let peerPubKeyB64: string | null = lookup;');
  });
});

describe('текст автору сторис', () => {
  const base = { mediaFailure: null, contacts: 0, delivered: 0 };

  it('о непрочитанном списке говорят прямо', () => {
    expect(storyPublishProblem({ ...base, contactsUnreadable: true }, 'image')).toMatch(
      /список контактов сейчас не прочитать/
    );
  });

  it('это важнее разговора о медиа: сторис не ушла вовсе', () => {
    const res = {
      ...base,
      contactsUnreadable: true,
      mediaFailure: { reason: 'oversize' as const, limitBytes: 1024 },
    };
    expect(storyPublishProblem(res, 'video')).toMatch(/список контактов сейчас не прочитать/);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
    expect(storyPublishProblem({ ...base, contacts: 2, delivered: 0 }, 'image')).toMatch(
      /не ушла ни одному контакту/
    );
    expect(storyPublishProblem({ ...base, contacts: 2, delivered: 2 }, 'image')).toBeNull();
    expect(storyPublishProblem(base, 'image')).toBeNull();
    expect(storyPublishProblem({ ...base, contactsUnreadable: false }, 'image')).toBeNull();
    expect(
      storyPublishProblem(
        { ...base, contacts: 1, delivered: 1, mediaFailure: { reason: 'failed', limitBytes: 1 } },
        'video'
      )
    ).toMatch(/Видео не загрузилось/);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const CONTACTS = read('contacts.ts');

  it('сплющивающая обёртка на месте и по-прежнему сводит два случая в один', () => {
    expect(codeOnly(CONTACTS)).toContain(
      'return (await listContactsReadFor(ownerProfileId)) ?? [];'
    );
  });

  it('различающее чтение отвечает null ровно при отказе', () => {
    expect(CONTACTS).toContain(
      'export async function listContactsReadFor(ownerProfileId: number): Promise<Contact[] | null> {'
    );
    expect(CONTACTS).toContain('Возвращает null ровно при отказе');
  });

  it('пустой список сам по себе законен: служба всё ещё умеет жить без контактов', () => {
    expect(MSG).toContain('if (subscribedCount === 0 && contacts.length > 0) {');
  });
});
