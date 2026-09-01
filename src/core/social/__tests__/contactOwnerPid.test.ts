/**
 * v4.32.464 — рэтчет: ключ переписки и строка контакта принадлежат паре ключей,
 * а не открытому экрану.
 *
 * Дефект: `getSymmetricKeyForPeer` и `ensureImplicitContact` определяли профиль
 * через `activeProfileId()`, хотя зовёт их только MessagingService, созданный
 * под конкретную пару ключей, и между расшифровкой конверта и этими вызовами
 * стоят await'ы на сеть и ECDH.
 *
 * Что ломалось. (приём) Пришло сообщение от контакта в «Личном»; человек
 * переключился на «Рабочий», где тот же собеседник тоже в контактах — вернулся
 * ключ пары «Рабочий↔собеседник», расшифровка не удалась, а на этот случай в
 * messaging.ts стоит «drop silently, no DB touch»: сообщение потеряно навсегда,
 * отправитель видит его отправленным. (отправка) `fanoutGroupMessage` рассылает
 * конверт участникам через `Promise.allSettled` — переключение посреди рассылки,
 * и остаток участников получает конверт, зашифрованный ключом другого аккаунта,
 * при том что подписан он текущей парой; отправителю засчитывается «отправлено».
 * (контакты) Незнакомец, написавший в «Личный», оказывался в списке контактов
 * «Рабочего» — при том что переписка сохранялась в «Личном».
 *
 * Правка сделана так, чтобы прежний вызов перестал существовать: номер профиля
 * — обязательный первый параметр, версии «по активному» нет. Тест это и держит.
 */
import * as fs from 'fs';
import * as path from 'path';

const CONTACTS = fs.readFileSync(path.join(__dirname, '..', 'contacts.ts'), 'utf8');
const MSG = fs.readFileSync(path.join(__dirname, '..', 'messaging.ts'), 'utf8');

/** Тело объявления: от строки заголовка до первой закрывающей `}` в 0-й колонке. */
function bodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const lines = source.slice(start).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (i > 0 && lines[i] === '}') break;
  }
  return out.join('\n');
}

const count = (h: string, n: string): number => h.split(n).length - 1;

/** Тело метода класса: от заголовка до первой закрывающей `}` во 2-й колонке. */
function methodBodyOf(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  const lines = source.slice(start).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (i > 0 && lines[i] === '  }') break;
  }
  return out.join('\n');
}

describe('contacts.ts — профиль приходит параметром', () => {
  it('getSymmetricKeyForPeer принимает номер профиля первым параметром', () => {
    expect(CONTACTS).toContain('export async function getSymmetricKeyForPeer(\n  ownerProfileId: number,');
  });

  it('ensureImplicitContact принимает номер профиля первым параметром', () => {
    expect(CONTACTS).toContain('export async function ensureImplicitContact(\n  ownerProfileId: number,');
  });

  it('ни одна из двух функций больше не спрашивает активный профиль', () => {
    for (const head of [
      'export async function getSymmetricKeyForPeer(',
      'export async function ensureImplicitContact(',
    ]) {
      expect(bodyOf(CONTACTS, head)).not.toContain('activeProfileId(');
    }
  });

  it('обе берут профиль из параметра, а не из соседнего источника', () => {
    for (const head of [
      'export async function getSymmetricKeyForPeer(',
      'export async function ensureImplicitContact(',
    ]) {
      expect(bodyOf(CONTACTS, head)).toContain('const pid = ownerProfileId;');
    }
  });

  it('кэш ключей по-прежнему разделён по профилям', () => {
    expect(bodyOf(CONTACTS, 'export async function getSymmetricKeyForPeer(')).toContain(
      '`${pid}:${peerPublicKeyB64}`'
    );
  });

  it('вариант «по активному профилю» не заведён обратно', () => {
    // Иначе правку можно было бы обойти, не изменив ни одного вызова.
    expect(CONTACTS).not.toContain('getSymmetricKeyForPeerFor');
    expect(CONTACTS).not.toContain('ensureImplicitContactFor');
  });
});

describe('messaging.ts — каждый вызов называет свой профиль', () => {
  it('вызовов ровно столько, сколько было, и все с профилем', () => {
    // Имя в строке импорта идёт без скобки, поэтому сюда попадают только вызовы.
    expect(count(MSG, 'getSymmetricKeyForPeer(')).toBe(7);
    expect(count(MSG, 'getSymmetricKeyForPeer(await this.ownerProfileId(), ')).toBe(5);
    expect(count(MSG, 'getSymmetricKeyForPeer(ownerPid, ')).toBe(2);
  });

  it('оба создания неявного контакта идут со своим профилем', () => {
    expect(count(MSG, 'ensureImplicitContact(')).toBe(2);
    expect(count(MSG, 'ensureImplicitContact(await this.ownerProfileId(), this.pair,')).toBe(1);
    expect(count(MSG, 'ensureImplicitContact(ownerPid, this.pair,')).toBe(1);
  });

  it('ни один вызов не остался без профиля', () => {
    expect(MSG).not.toContain('getSymmetricKeyForPeer(contactPubB64)');
    expect(MSG).not.toContain('getSymmetricKeyForPeer(peerPubKeyB64)');
    expect(MSG).not.toContain('ensureImplicitContact(this.pair');
  });

  it('в sendMessageWork профиль спрашивается один раз и до первого использования', () => {
    const body = methodBodyOf(MSG, '  private async sendMessageWork(');
    expect(count(body, 'await this.ownerProfileId()')).toBe(1);
    expect(body.indexOf('const ownerPid = await this.ownerProfileId();')).toBeLessThan(
      body.indexOf('getSymmetricKeyForPeer(ownerPid,')
    );
    // и не объявляется второй раз ниже по той же функции
    expect(count(body, 'const ownerPid =')).toBe(1);
  });
});

describe('проверка не пустая', () => {
  it('исходники прочитаны', () => {
    expect(CONTACTS.length).toBeGreaterThan(1000);
    expect(MSG.length).toBeGreaterThan(1000);
  });

  it('bodyOf возвращает тело, а не весь файл', () => {
    const body = bodyOf(CONTACTS, 'export async function getSymmetricKeyForPeer(');
    expect(body.length).toBeLessThan(CONTACTS.length / 2);
    expect(body.trimEnd().endsWith('}')).toBe(true);
  });
});
