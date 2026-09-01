/**
 * v4.32.560: нажатие на уведомление о группе ведёт в группу.
 *
 * Дефект был тройной и весь в одном показе. Групповой баннер не нёс полезной
 * нагрузки вовсе — `displayNotification` звали без `data`, — поэтому разбирать
 * было нечего и нажатие вело туда же, куда и до v4.32.558: в приложение на той
 * вкладке, где его свернули. Имени у баннера тоже не было, и двадцать
 * сообщений в оживлённой группе давали двадцать строк в шторке вместо одной.
 * А проверки «эту группу человек сейчас и читает» не было ни в каком виде:
 * телефон дёргался на каждое сообщение открытой на экране группы.
 *
 * Проверяется правило (разбор нагрузки, имя баннера, подавление) и то, что оба
 * конца сведены к нему: показ кладёт нагрузку, экран вкладок её разбирает.
 */
import fs from 'fs';
import path from 'path';

import { shouldSuppressGroupBanner, type OpenChatState } from '../activeChatSuppress';
import { bannerIdForCid, bannerIdForGroup } from '../bannerId';
import {
  deliverOpenIntent,
  heldOpenIntent,
  parseChatOpenIntent,
  parseOpenIntent,
  resetOpenIntents,
  setOpenIntentConsumer,
  type OpenIntent,
} from '../openIntent';

const read = (...rel: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');

const PUSH = (): string => read('pushNotifications.ts');
const APP = (): string => read('..', 'App.tsx');
const GROUPS = (): string => read('..', 'ui', 'screens', 'GroupsScreen.tsx');
const MESSAGING = (): string => read('..', 'core', 'social', 'groupMessaging.ts');

const GID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const MID = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
const CID = 'a1b2c3d4e5f60718';

beforeEach(() => resetOpenIntents());
afterEach(() => resetOpenIntents());

describe('разбор групповой нагрузки уведомления', () => {
  it('groupId и msgId проходят целиком', () => {
    expect(parseOpenIntent({ groupId: GID, msgId: MID })).toEqual({
      kind: 'group',
      groupId: GID,
      msgId: MID,
    });
  });

  it('без msgId намерение остаётся: открывать всё равно есть что', () => {
    expect(parseOpenIntent({ groupId: GID })).toEqual({ kind: 'group', groupId: GID });
  });

  it('негодный msgId отбрасывается, а группа остаётся', () => {
    expect(parseOpenIntent({ groupId: GID, msgId: 'с пробелом' })).toEqual({
      kind: 'group',
      groupId: GID,
    });
    expect(parseOpenIntent({ groupId: GID, msgId: 42 })).toEqual({ kind: 'group', groupId: GID });
  });

  it.each(['', 'с пробелом', 'a/b', 'a\nb', 'x'.repeat(129)])(
    'негодный groupId (%p) групповым намерением не становится',
    (bad) => {
      expect(parseOpenIntent({ groupId: bad })).toBeNull();
    }
  );

  it('групповая нагрузка не притворяется личной', () => {
    // Иначе запрос к базе ушёл бы с идентификатором группы вместо сообщения.
    expect(parseChatOpenIntent({ groupId: GID, msgId: MID })).toBeNull();
    expect(parseChatOpenIntent({ cid: CID })).toEqual({ kind: 'chat', cid: CID });
  });

  it('пустой groupId не мешает разобрать личную нагрузку', () => {
    expect(parseOpenIntent({ groupId: '', cid: CID })).toEqual({ kind: 'chat', cid: CID });
  });
});

describe('групповое нажатие раньше получателя', () => {
  it('без получателя намерение ждёт, а не пропадает', () => {
    expect(deliverOpenIntent({ kind: 'group', groupId: GID }, 'background-press')).toBe('held');
    expect(heldOpenIntent()).toEqual({ kind: 'group', groupId: GID });
  });

  it('получатель забирает групповое намерение, не путая его с личным', () => {
    const seen: OpenIntent[] = [];
    setOpenIntentConsumer((i) => seen.push(i));
    deliverOpenIntent({ kind: 'group', groupId: GID, msgId: MID }, 'foreground-press');
    deliverOpenIntent({ kind: 'chat', cid: CID }, 'foreground-press');
    expect(seen).toEqual([
      { kind: 'group', groupId: GID, msgId: MID },
      { kind: 'chat', cid: CID },
    ]);
  });

  it('группа и переписка с одинаковым идентификатором повтором не считаются', () => {
    setOpenIntentConsumer(() => undefined);
    expect(deliverOpenIntent({ kind: 'group', groupId: CID }, 'cold-start')).toBe('delivered');
    expect(deliverOpenIntent({ kind: 'chat', cid: CID }, 'cold-start')).toBe('delivered');
  });

  it('то же сообщение группы на старте отдаётся один раз', () => {
    setOpenIntentConsumer(() => undefined);
    expect(deliverOpenIntent({ kind: 'group', groupId: GID, msgId: MID }, 'background-press')).toBe(
      'delivered'
    );
    expect(deliverOpenIntent({ kind: 'group', groupId: GID, msgId: MID }, 'cold-start')).toBe(
      'duplicate'
    );
  });

  it('новое сообщение в той же группе повтором не считается', () => {
    setOpenIntentConsumer(() => undefined);
    deliverOpenIntent({ kind: 'group', groupId: GID, msgId: MID }, 'background-press');
    expect(
      deliverOpenIntent({ kind: 'group', groupId: GID, msgId: 'ff00-1' }, 'cold-start')
    ).toBe('delivered');
  });
});

describe('имя баннера', () => {
  it('одно на группу — новый баннер заменяет прежний', () => {
    expect(bannerIdForGroup(GID)).toBe(`group:${GID}`);
    expect(bannerIdForGroup(GID)).toBe(bannerIdForGroup(GID));
  });

  it('групповое имя не сталкивается с личным', () => {
    expect(bannerIdForGroup(CID)).not.toBe(bannerIdForCid(CID));
  });
});

describe('группа открыта прямо сейчас', () => {
  const open = (over: Partial<OpenChatState> = {}): OpenChatState => ({
    peerDid: null,
    groupId: GID,
    tab: 'groups',
    appState: 'active',
    ...over,
  });

  it('баннер о группе, которую человек читает, не показывается', () => {
    expect(shouldSuppressGroupBanner(open(), GID)).toBe(true);
  });

  it('сообщение из другой группы показывается всегда', () => {
    expect(shouldSuppressGroupBanner(open(), 'другая')).toBe(false);
  });

  it.each(['chat', 'feed', 'profile', 'settings', null])(
    'вкладка %p — баннер нужен',
    (tab) => {
      expect(shouldSuppressGroupBanner(open({ tab }), GID)).toBe(false);
    }
  );

  it.each(['background', 'inactive', null])(
    'приложение не на переднем плане (%p) — баннер нужен',
    (appState) => {
      expect(shouldSuppressGroupBanner(open({ appState }), GID)).toBe(false);
    }
  );

  it('ничего не открыто — баннер нужен', () => {
    expect(shouldSuppressGroupBanner(open({ groupId: null }), GID)).toBe(false);
    expect(shouldSuppressGroupBanner(open(), null)).toBe(false);
    expect(shouldSuppressGroupBanner(open(), undefined)).toBe(false);
  });

  it('открытая группа не глушит личный баннер и наоборот', () => {
    // Обе проверки читают своё поле: перепутать их полями нечем.
    expect(shouldSuppressGroupBanner({ ...open(), tab: 'chat', peerDid: 'did:key:zA' }, GID)).toBe(
      false
    );
  });
});

describe('форма исходников', () => {
  it('показ группы кладёт в уведомление и группу, и сообщение', () => {
    const src = PUSH();
    expect(src).toContain("...(groupId ? { data: { groupId, groupKind: kind ?? 'group', msgId: msgId ?? '' } } : {}),");
    expect(src).toContain('...(groupId ? { id: bannerIdForGroup(groupId) } : {}),');
  });

  it('показ группы спрашивает, не открыта ли она', () => {
    const src = PUSH();
    expect(src).toContain('shouldSuppressGroupBanner(openScreenState(), groupId)');
    // Проверка идёт до показа, а не после него.
    expect(src.indexOf('shouldSuppressGroupBanner')).toBeLessThan(
      src.indexOf('bannerIdForGroup(groupId)')
    );
  });

  it('обе проверки подавления берут один снимок экрана', () => {
    const src = PUSH();
    expect(src).toContain('function openScreenState()');
    expect(src).toContain('shouldSuppressDmBanner(openScreenState(), contactDid)');
  });

  it('идентификатор сообщения доезжает до показа от разбора конверта', () => {
    expect(MESSAGING()).toContain('kind, isMention, env.msgId)');
  });

  it('экран групп сообщает, какая группа открыта', () => {
    const src = GROUPS();
    expect(src).toContain("import { setActiveGroupId } from '../../notifications/pushNotifications';");
    expect(src).toContain("const openGroupId = nav.screen === 'chat' ? nav.group.id : null;");
    expect(src).toContain('return () => { setActiveGroupId(null); };');
  });

  it('экран вкладок разводит группу и переписку', () => {
    const src = APP();
    expect(src).toContain("if (intent.kind === 'group') {");
    expect(src).toContain('setGroupJump({ groupId: intent.groupId, token: Date.now() });');
    expect(src).toContain("mountTab('groups');");
  });
});
