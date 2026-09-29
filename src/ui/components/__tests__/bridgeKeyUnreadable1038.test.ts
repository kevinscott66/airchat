/**
 * Нечитаемый ключ моста уносил единственный отзыв доступа (v4.32.1038).
 *
 * ДЕФЕКТ. `loadBridgeSecret` читал SecureStore ВНЕ своего try. Контракт
 * обёртки (`storage/secureStoreQueued`) прямо говорит: «нет записи» — это
 * `null`, «не читается» — исключение. Исключение уходило из эффекта секции
 * настроек, `accessKey` оставался пустым, и весь блок под
 * `{enabled && accessKey ? (` не рисовался.
 *
 * ЦЕНА. В этом блоке живёт «Новый ключ» — единственный в приложении способ
 * отозвать доступ у внешнего агента. Пропадал он молча и ровно в худший
 * момент: рычажок при этом честно показывал «включено» (отметка лежит в
 * другом хранилище и читается), то есть мост работает, ключ у кого-то на
 * руках, а отозвать нечем. Что может сделать держатель ключа, сказано в
 * подписи самой секции: перевести доставку сообщений на свой сервер.
 * Нечитаемость здесь не мигает — сброс Keystore на Android (смена отпечатка
 * или блокировки) держится до переустановки.
 *
 * ПРАВКА. Чтение стало исходом: `loadBridgeSecretTry` отвечает `null` на
 * «прочитать не смогли» и `{ secret }` — на «прочитали». Сам
 * `loadBridgeSecret` по-прежнему бросает: подъём моста на такой ответ обязан
 * споткнуться, а не завести новый ключ поверх чужого. Секция на `null`
 * говорит словами, что показать нечего, и оставляет «Новый ключ»: новый
 * секрет пишется ПОВЕРХ прежнего, читать прежний для этого не нужно.
 *
 * ГРАНИЦЫ. «Записи нет» и «не прочитали» остаются разными ответами: у
 * первого блок гаснет правильно — отзывать нечего. Удачное чтение отметку
 * снимает, поэтому одна осечка не остаётся на экране навсегда.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockStore: Record<string, string | null> = {};
let mockReadThrows = false;

jest.mock('../../../core/storage/secureStoreQueued', () => ({
  getItemAsync: jest.fn(async (k: string) => {
    // Контракт обёртки: «нет записи» — null, «не читается» — исключение.
    if (mockReadThrows) throw new Error('keystore reset');
    return mockStore[k] ?? null;
  }),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore[k] = v; }),
  deleteItemAsync: jest.fn(async (k: string) => { delete mockStore[k]; }),
}));

import { loadBridgeSecret, loadBridgeSecretTry } from '../../../core/bridge/agentBridgeKeys';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const SECTION = (): string => read('ui/components/AgentBridgeSettingsSection.tsx');
const KEYS = (): string => read('core/bridge/agentBridgeKeys.ts');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  mockReadThrows = false;
});

describe('чтение секрета исходом', () => {
  it('записи нет — прочитали, внутри пусто', async () => {
    await expect(loadBridgeSecretTry()).resolves.toEqual({ secret: null });
  });

  it('хранилище не отвечает — «не прочитали», а не «нет записи»', async () => {
    mockReadThrows = true;
    await expect(loadBridgeSecretTry()).resolves.toBeNull();
  });

  it('секрет на месте — отдаётся байтами', async () => {
    mockStore['airchat_agent_bridge_secret'] = Buffer.alloc(32, 7).toString('base64');
    const got = await loadBridgeSecretTry();
    expect(got).not.toBeNull();
    expect(got!.secret).toBeInstanceOf(Uint8Array);
    expect(got!.secret!.length).toBe(32);
  });

  it('короткая форма по-прежнему БРОСАЕТ: подъём моста обязан споткнуться', async () => {
    mockReadThrows = true;
    await expect(loadBridgeSecret()).rejects.toThrow();
  });

  it('проверка не пустая: без отказа короткая форма отвечает как раньше', async () => {
    await expect(loadBridgeSecret()).resolves.toBeNull();
  });
});

describe('форма исходников', () => {
  it('чтение исходом заведено и отличает «не смогли» от «нет записи»', () => {
    const k = codeOnly(KEYS());
    expect(k).toContain(
      'export async function loadBridgeSecretTry(): Promise<{ secret: Uint8Array | null } | null> {'
    );
    expect(k).toContain('return { secret: await loadBridgeSecret() };');
  });

  it('секция читает исходом, а не короткой формой', () => {
    const s = codeOnly(SECTION());
    expect(s).toContain('const got = await loadBridgeSecretTry();');
    expect(s).not.toContain('const secret = await loadBridgeSecret();');
  });

  it('«не прочитали» и «нет записи» разведены на экране', () => {
    const s = codeOnly(SECTION());
    // Отказ хранилища поднимает отметку, пустая запись её снимает.
    const bad = s.indexOf('if (got === null) {');
    const empty = s.indexOf('if (!got.secret) {');
    expect(bad).toBeGreaterThan(0);
    expect(empty).toBeGreaterThan(bad);
    expect(s.slice(bad, empty)).toContain('setKeyUnread(true);');
    expect(s.slice(empty, empty + 200)).toContain('setKeyUnread(false);');
  });

  it('отказ настроек не оставляет блок пустым молча', () => {
    const s = codeOnly(SECTION());
    expect(s).toContain("log.warn('agent_bridge_key_show_failed'");
  });

  it('нечитаемый ключ блок не гасит, а кнопка отзыва в нём остаётся', () => {
    const body = SECTION();
    const block = body.indexOf('{enabled && (accessKey || keyUnread) ? (');
    expect(block).toBeGreaterThan(0);
    const end = body.indexOf('    </View>\n  );', block);
    expect(end).toBeGreaterThan(block);
    const inner = body.slice(block, end);
    expect(inner).toContain('testID="agent_bridge_revoke"');
    // Показывать нечего — но эти три вещи спрятаны отдельно от кнопки отзыва.
    expect(inner).toContain('{accessKey ? (');
    for (const at of ['testID="agent_bridge_reveal"', '<BrandedQr', 'testID="agent_bridge_copy"']) {
      const i = inner.indexOf(at);
      expect(i).toBeGreaterThan(0);
      expect(inner.lastIndexOf('{accessKey ? (', i)).toBeGreaterThan(0);
    }
  });

  it('человеку сказано словами, что ключ не прочитался и что делать', () => {
    const s = SECTION();
    expect(s).toContain('const KEY_UNREAD_NOTE =');
    expect(codeOnly(s)).toContain('{enabled && keyUnread ? <Text style={styles.warn}>{KEY_UNREAD_NOTE}</Text> : null}');
    // Янтарь — второй сигнал; красным здесь не пугаем, мост работает.
    expect(s).toContain('warn: { color: c.warning');
  });

  it('ГРАНИЦА: отметка не залипает — удачное чтение её снимает', () => {
    const s = codeOnly(SECTION());
    expect(s.split('setKeyUnread(false);').length - 1).toBe(2);
  });
});
