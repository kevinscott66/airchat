/**
 * v4.32.558: нажатие на уведомление ведёт в переписку.
 *
 * Проверяется и правило (разбор полезной нагрузки, хранение намерения до
 * появления получателя, отсев повтора), и то, что все три пути нажатия
 * действительно сведены к нему: обработчик при открытом приложении, фоновый
 * обработчик и чтение уведомления, которым приложение запустили.
 */
import fs from 'fs';
import path from 'path';

import {
  deliverOpenIntent,
  heldOpenIntent,
  parseOpenIntent,
  resetOpenIntents,
  setOpenIntentConsumer,
  type IntentSource,
  type OpenIntent,
} from '../openIntent';

const read = (...rel: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');

const MODULE = (): string => read('openIntent.ts');
const PUSH = (): string => read('pushNotifications.ts');
const BACKGROUND = (): string => read('..', 'firebaseMessagingBackground.ts');
const APP = (): string => read('..', 'App.tsx');

const CID = 'a1b2c3d4e5f60718';
const DID = 'did:key:z6MkfooBarBaz';

beforeEach(() => resetOpenIntents());
afterEach(() => resetOpenIntents());

describe('разбор полезной нагрузки уведомления', () => {
  it('cid и DID проходят целиком', () => {
    expect(parseOpenIntent({ cid: CID, contactDid: DID })).toEqual({ kind: 'chat' as const, cid: CID, contactDid: DID });
  });

  it('заглавные шестнадцатеричные знаки — тоже cid', () => {
    expect(parseOpenIntent({ cid: CID.toUpperCase() })).toEqual({ kind: 'chat' as const, cid: CID.toUpperCase() });
  });

  it('senderDid принимается как запасное имя того же поля', () => {
    expect(parseOpenIntent({ cid: CID, senderDid: DID })).toEqual({ kind: 'chat' as const, cid: CID, contactDid: DID });
  });

  it('без cid намерения нет — открывать нечего', () => {
    expect(parseOpenIntent({ contactDid: DID })).toBeNull();
    expect(parseOpenIntent({ cid: 'короткий' })).toBeNull();
    expect(parseOpenIntent({ cid: 42 })).toBeNull();
    expect(parseOpenIntent(null)).toBeNull();
    expect(parseOpenIntent(undefined)).toBeNull();
  });

  it('негодный DID отбрасывается, а намерение остаётся', () => {
    expect(parseOpenIntent({ cid: CID, contactDid: 'не-did' })).toEqual({ kind: 'chat' as const, cid: CID });
    expect(parseOpenIntent({ cid: CID, contactDid: `did:key:z${'a'.repeat(300)}` })).toEqual({ kind: 'chat' as const, cid: CID });
    expect(parseOpenIntent({ cid: CID, contactDid: 42 })).toEqual({ kind: 'chat' as const, cid: CID });
  });

  it('cid длиннее ста двадцати восьми знаков не проходит', () => {
    expect(parseOpenIntent({ cid: 'ab'.repeat(65) })).toBeNull();
  });
});

describe('нажатие раньше получателя', () => {
  it('без получателя намерение ждёт, а не пропадает', () => {
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'cold-start')).toBe('held');
    expect(heldOpenIntent()).toEqual({ kind: 'chat' as const, cid: CID });
  });

  it('появившийся получатель забирает ожидающее намерение сразу', () => {
    deliverOpenIntent({ kind: 'chat' as const, cid: CID, contactDid: DID }, 'cold-start');
    const seen: Array<[OpenIntent, IntentSource]> = [];
    setOpenIntentConsumer((i, s) => seen.push([i, s]));
    expect(seen).toEqual([[{ kind: 'chat' as const, cid: CID, contactDid: DID }, 'cold-start']]);
    expect(heldOpenIntent()).toBeNull();
  });

  it('при живом получателе намерение уходит сразу и ничего не ждёт', () => {
    const seen: OpenIntent[] = [];
    setOpenIntentConsumer((i) => seen.push(i));
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'foreground-press')).toBe('delivered');
    expect(seen).toEqual([{ kind: 'chat' as const, cid: CID }]);
    expect(heldOpenIntent()).toBeNull();
  });

  it('после снятия получателя намерения снова ждут, а не теряются', () => {
    const seen: OpenIntent[] = [];
    const off = setOpenIntentConsumer((i) => seen.push(i));
    off();
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'background-press')).toBe('held');
    expect(seen).toEqual([]);
    expect(heldOpenIntent()).toEqual({ kind: 'chat' as const, cid: CID });
  });

  it('снятие старого получателя не отключает пришедшего ему на смену', () => {
    const first: OpenIntent[] = [];
    const second: OpenIntent[] = [];
    const offFirst = setOpenIntentConsumer((i) => first.push(i));
    setOpenIntentConsumer((i) => second.push(i));
    offFirst();
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'foreground-press')).toBe('delivered');
    expect(first).toEqual([]);
    expect(second).toEqual([{ kind: 'chat' as const, cid: CID }]);
  });

  it('пока получателя нет, ждёт последнее нажатие', () => {
    deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'background-press');
    deliverOpenIntent({ kind: 'chat' as const, cid: 'ffffffffffffffff' }, 'background-press');
    expect(heldOpenIntent()).toEqual({ kind: 'chat' as const, cid: 'ffffffffffffffff' });
  });
});

describe('одно нажатие не открывает переписку дважды', () => {
  it('тот же cid событием и ответом на старте отдаётся один раз', () => {
    const seen: IntentSource[] = [];
    setOpenIntentConsumer((_i, s) => seen.push(s));
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'background-press')).toBe('delivered');
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'cold-start')).toBe('duplicate');
    expect(seen).toEqual(['background-press']);
  });

  it('повтор не вытесняет ожидающее намерение', () => {
    deliverOpenIntent({ kind: 'chat' as const, cid: CID, contactDid: DID }, 'background-press');
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'cold-start')).toBe('duplicate');
    expect(heldOpenIntent()).toEqual({ kind: 'chat' as const, cid: CID, contactDid: DID });
  });

  it('другое сообщение повтором не считается', () => {
    deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'background-press');
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: 'ffffffffffffffff' }, 'foreground-press')).toBe('held');
  });

  // v4.32.560: правило писалось против двойной доставки на холодном старте, а
  // гасило и второе настоящее нажатие — открыть из шторки, вернуться в список,
  // нажать тот же баннер снова и не получить ничего.
  it('второе нажатие по тому же баннеру доходит, а не гасится как повтор', () => {
    const seen: IntentSource[] = [];
    setOpenIntentConsumer((_i, source) => seen.push(source));
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'foreground-press')).toBe('delivered');
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'foreground-press')).toBe('delivered');
    expect(seen).toEqual(['foreground-press', 'foreground-press']);
  });

  it('нажатие при закрытом приложении тоже не гасится повтором', () => {
    deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'cold-start');
    expect(deliverOpenIntent({ kind: 'chat' as const, cid: CID }, 'background-press')).toBe('held');
  });
});

describe('форма исходников', () => {
  it('модуль ни от чего не зависит: его зовут и из фонового запуска JS', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });

  it('проверка формы cid осталась ровно в одном месте', () => {
    const shape = /a-f0-9\]\{16,128\}/g;
    expect((MODULE().match(shape) ?? []).length).toBe(1);
    expect(PUSH()).not.toMatch(shape);
    expect(BACKGROUND()).not.toMatch(shape);
  });

  it('обработчик нажатия при открытом приложении больше не зовёт несуществующий onOpenChat', () => {
    const src = PUSH();
    expect(src).not.toContain('options.onOpenChat?.(');
    expect(src).not.toContain('onOpenChat?:');
    expect(src).toContain("deliverOpenIntent(intent, 'foreground-press')");
  });

  it('нажатие, запустившее приложение, читается на старте', () => {
    const src = PUSH();
    expect(src).toContain('await notifee.getInitialNotification()');
    expect(src).toContain("deliverOpenIntent(intent, 'cold-start')");
  });

  it('фоновый обработчик notifee зарегистрирован вне дерева компонентов', () => {
    const src = BACKGROUND();
    expect(src).toContain('notifee.onBackgroundEvent(');
    expect(src).toContain("deliverOpenIntent(intent, 'background-press')");
    expect(src).toContain('if (type !== EventType.PRESS) return;');
  });

  it('экран вкладок — единственный, кто открывает переписку по намерению', () => {
    const src = APP();
    expect(src).toContain('setOpenIntentConsumer((intent, source) => {');
    expect(src).toContain("mountTab('chat');");
    expect(src).toContain('handlePushOpen(intent.cid, intent.contactDid)');
    expect(src).toContain("log.info('notification_open_intent'");
  });
});
