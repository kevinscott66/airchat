import { readFileSync } from 'fs';
import { join } from 'path';
import {
  STATUS_GRACE_MS,
  isAccountSyncActive,
  markAccountSyncEnd,
  markAccountSyncStart,
  rawStatus,
  resetAccountSyncForTests,
  settledStatus,
  subscribeAccountSync,
} from '../connectionStatus';

const root = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('что показывать в полоске состояния', () => {
  it('пока связи нет — «Соединение…», даже если синхронизация числится идущей', () => {
    // Синхронизация без связи никуда не идёт: назвать её идущей значит
    // пообещать данные, которые не приедут.
    expect(rawStatus({ relay: 'connecting', syncing: true })).toBe('connecting');
    expect(rawStatus({ relay: 'connecting', syncing: false })).toBe('connecting');
  });

  it('связь есть и идёт синхронизация — «Обновление…»', () => {
    expect(rawStatus({ relay: 'online', syncing: true })).toBe('updating');
  });

  it('транспорт не запущен, но аккаунт синхронизируется — всё равно «Обновление…»', () => {
    // Синхронизация аккаунта идёт в хранилище по HTTPS и от ретранслятора не
    // зависит: на экране входа и при выключенном интернет-транспорте она
    // остаётся единственным, что происходит.
    expect(rawStatus({ relay: 'off', syncing: true })).toBe('updating');
  });

  it('связь есть и делать нечего — молчим', () => {
    expect(rawStatus({ relay: 'online', syncing: false })).toBe('idle');
    expect(rawStatus({ relay: 'off', syncing: false })).toBe('idle');
  });
});

describe('задержка показа', () => {
  it('короткий обрыв не показывается', () => {
    expect(settledStatus('connecting', STATUS_GRACE_MS.connecting - 1)).toBe('idle');
    expect(settledStatus('updating', STATUS_GRACE_MS.updating - 1)).toBe('idle');
  });

  it('продержавшееся состояние называется вслух', () => {
    expect(settledStatus('connecting', STATUS_GRACE_MS.connecting)).toBe('connecting');
    expect(settledStatus('updating', STATUS_GRACE_MS.updating + 5_000)).toBe('updating');
  });

  it('у «Соединения…» порог выше, чем у «Обновления…»', () => {
    // Обрыв сокета на мобильной сети — обычное дело, и мигание полоски на
    // каждом таком обрыве читается как неисправность.
    expect(STATUS_GRACE_MS.connecting).toBeGreaterThan(STATUS_GRACE_MS.updating);
  });

  it('молчание не ждёт ничего', () => {
    expect(settledStatus('idle', 0)).toBe('idle');
  });
});

describe('счётчик заходов синхронизации', () => {
  beforeEach(() => resetAccountSyncForTests());

  it('первый закончившийся заход не гасит полоску за остальных', () => {
    markAccountSyncStart();
    markAccountSyncStart();
    markAccountSyncEnd();
    expect(isAccountSyncActive()).toBe(true);
    markAccountSyncEnd();
    expect(isAccountSyncActive()).toBe(false);
  });

  it('лишний конец не уводит счётчик в минус', () => {
    markAccountSyncEnd();
    expect(isAccountSyncActive()).toBe(false);
    markAccountSyncStart();
    expect(isAccountSyncActive()).toBe(true);
  });

  it('подписчику сообщают только о смене состояния', () => {
    const seen: boolean[] = [];
    const off = subscribeAccountSync(() => seen.push(isAccountSyncActive()));
    markAccountSyncStart();
    markAccountSyncStart();
    markAccountSyncEnd();
    markAccountSyncEnd();
    off();
    markAccountSyncStart();
    expect(seen).toEqual([true, false]);
  });
});

describe('проводка', () => {
  it('отметка стоит вокруг самого прохода, а не вокруг ожидания очереди', () => {
    const src = read('core/sync/liveAccountSync.ts');
    expect(src).toContain('markAccountSyncStart();');
    expect(src).toContain('runLiveSync(mnemonic, pair, ownerProfileId).finally(markAccountSyncEnd)');
  });

  it('полоска стоит над очередью отправки', () => {
    const app = read('App.tsx');
    const connection = app.indexOf('<ConnectionStatus />');
    const offline = app.indexOf('<OfflineStatus />');
    expect(connection).toBeGreaterThan(0);
    expect(offline).toBeGreaterThan(connection);
  });

  it('полоска берёт слова у модели, а не пишет их заново', () => {
    const ui = read('ui/components/ConnectionStatus.tsx');
    expect(ui).toContain("'Соединение…'");
    expect(ui).toContain("'Обновление…'");
    expect(ui).toContain('settledStatus(raw, now - heldRef.current.since)');
  });
});
