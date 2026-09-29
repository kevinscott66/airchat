/**
 * Непрочитанная отметка моста выдавалась за «мост выключен» (v4.32.1028).
 *
 * ДЕФЕКТ. `isBridgeEnabled` отвечала `(await kvGet(ENABLED_KEY)) === 'true'`,
 * а `kvGet` сводит отказ базы и отсутствие записи к одному `null`. Для
 * запуска это правильный ответ — канал управления телефоном не должен
 * открываться оттого, что базу не прочитали. Но ту же дверь спрашивал экран
 * настроек, и там «не прочитали» превращалось в уверенное «выключено».
 *
 * ЦЕНА. Мост живёт в памяти: его поднимает `startAgentBridgeIfEnabled` из
 * App.tsx при запуске, и сокет работает независимо от того, читается ли
 * отметка сейчас. Отказ базы на открытии настроек рисовал рычажок в «выкл» —
 * а весь блок ключа стоит под `enabled && accessKey`, и вместе с рычажком
 * исчезала единственная кнопка отзыва, «Новый ключ». То есть человеку
 * говорили, что управление извне выключено, ровно в тот момент, когда оно
 * включено, и отзывать доступ было нечем. Хуже второе место: отзыв ключа
 * спрашивал ту же дверь (`if ((await isBridgeEnabled()) && …)`), и при отказе
 * чтения перезапуск пропускался совсем. Живой сокет держит ключи,
 * выведенные из ПРЕЖНЕГО секрета (`state.keys` считаются один раз при
 * подъёме), так что прежний ключ продолжал открывать кадры — под зелёным
 * «Выдан новый ключ. Прежний больше не действует».
 *
 * ПРАВКА. Появилась `bridgeEnabledTry` — отметка тремя состояниями. Запуск
 * по-прежнему спрашивает `isBridgeEnabled` и отказ читает как «выключен»:
 * закрытый по недоразумению канал беды не делает. Экран спрашивает
 * `bridgeEnabledTry`, а непрочитанную отметку заменяет свидетелем из
 * памяти — `isBridgeRunning()`, — и говорит об этом словами. Отзыв ключа
 * спрашивает того же свидетеля: вопрос там именно «жив ли сокет с прежними
 * ключами», а не «что записано на диске».
 *
 * ГРАНИЦЫ. Значение по умолчанию не меняется: нет записи — мост выключен
 * (сравнение `=== 'true'`, а не `!== 'false'`, заведено нарочно).
 */
import fs from 'fs';
import path from 'path';

/** Что лежит в device-local хранилище. */
const mockKv: Record<string, string> = {};
/** Ключи, чтение которых отказывает (занятая база). */
let mockReadFails = new Set<string>();

jest.mock('../../storage/local', () => ({
  kvTryGet: jest.fn(async (k: string) =>
    (mockReadFails.has(k) ? null : { value: mockKv[k] ?? null })),
  kvGet: jest.fn(async (k: string) => (mockReadFails.has(k) ? null : mockKv[k] ?? null)),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    mockKv[k] = v;
    return true;
  }),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../config', () => ({ loadConfig: jest.fn(async () => ({})) }));

/** Исполнение команд сюда не входит — и тянет за собой весь транспорт. */
jest.mock('../agentBridgeCommands', () => ({
  KNOWN_COMMANDS: ['whoami'],
  runBridgeCommand: jest.fn(),
  parseCommand: jest.fn(() => null),
}));

import { isBridgeEnabled } from '../agentBridge';

const ENABLED_KEY = 'agent_bridge_enabled';

const SRC = path.join(__dirname, '..', '..', '..');
/** Только код: докблок не должен сам удовлетворять проверку. */
const codeOnly = (rel: string): string =>
  fs
    .readFileSync(path.join(SRC, rel), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const BRIDGE = (): string => codeOnly('core/bridge/agentBridge.ts');
const SECTION = (): string => codeOnly('ui/components/AgentBridgeSettingsSection.tsx');
const LOCAL = (): string => codeOnly('core/storage/local.ts');

/** Текст, которым экран признаётся, что отметку прочитать не вышло. */
const MSG_UNREAD =
  'Настройку прочитать не удалось. Показано, работает ли мост прямо сейчас; после перезапуска приложения состояние может оказаться другим.';

beforeEach(() => {
  for (const k of Object.keys(mockKv)) delete mockKv[k];
  mockReadFails = new Set<string>();
});

describe('отметка отвечает тремя состояниями', () => {
  it('базу не прочитали — это не «выключено», а «не знаем»', async () => {
    mockKv[ENABLED_KEY] = 'true';
    mockReadFails.add(ENABLED_KEY);
    const { bridgeEnabledTry } = await import('../agentBridge');

    await expect(bridgeEnabledTry()).resolves.toBeNull();
  });

  it('прочитанное «включено» приходит словом', async () => {
    mockKv[ENABLED_KEY] = 'true';
    const { bridgeEnabledTry } = await import('../agentBridge');

    await expect(bridgeEnabledTry()).resolves.toEqual({ on: true });
  });

  it('ГРАНИЦА: записи нет — мост выключен, как и было заведено', async () => {
    const { bridgeEnabledTry } = await import('../agentBridge');

    await expect(bridgeEnabledTry()).resolves.toEqual({ on: false });
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: запуск по-прежнему закрывается на отказе', () => {
  it('отказ чтения запуск читает как «выключен»', async () => {
    mockKv[ENABLED_KEY] = 'true';
    mockReadFails.add(ENABLED_KEY);

    await expect(isBridgeEnabled()).resolves.toBe(false);
  });

  it('«включено» на диске так и читается', async () => {
    mockKv[ENABLED_KEY] = 'true';

    await expect(isBridgeEnabled()).resolves.toBe(true);
  });

  it('«выключено» и отсутствие записи — оба выключены', async () => {
    mockKv[ENABLED_KEY] = 'false';
    await expect(isBridgeEnabled()).resolves.toBe(false);

    delete mockKv[ENABLED_KEY];
    await expect(isBridgeEnabled()).resolves.toBe(false);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('kvTryGet и правда отвечает null на отказ базы', () => {
    const body = LOCAL();
    const at = body.indexOf('export async function kvTryGet(key: string)');
    expect(at).toBeGreaterThan(0);
    const head = body.slice(at, at + 600);
    expect(head).toContain('} catch (e) {');
    expect(head.indexOf('return null;', head.indexOf('} catch (e) {'))).toBeGreaterThan(0);
  });

  it('мост живёт в памяти: его поднимают при запуске, а свидетель дешёвый', () => {
    expect(codeOnly('App.tsx')).toContain('m.startAgentBridgeIfEnabled()');
    const body = BRIDGE();
    expect(body).toContain('export function isBridgeRunning(): boolean {');
    expect(body).toContain('return !!state?.active;');
  });

  it('кнопка отзыва живёт внутри блока, который гасится рычажком', () => {
    const body = SECTION();
    const block = body.indexOf('{enabled && accessKey ? (');
    expect(block).toBeGreaterThan(0);
    const end = body.indexOf('    </View>\n  );', block);
    expect(end).toBeGreaterThan(block);
    // «Новый ключ» — единственный отзыв в приложении, и он стоит здесь.
    expect(body.slice(block, end)).toContain('Новый ключ');
    expect(body.slice(block, end)).toContain('testID="agent_bridge_revoke"');
  });

  it('живой сокет держит ключи прежнего секрета — смена ключа сама его не рвёт', () => {
    const body = BRIDGE();
    // Ключи выводятся один раз, при подъёме, и дальше кадры открываются ими.
    expect(body).toContain('keys: deriveBridgeKeys(secret),');
    expect(body).toContain('const payload = openFrame(s.keys.aeadKey, head);');
    // Рвёт сокет только перезапуск — с него и начинается подъём.
    const at = body.indexOf('export async function startAgentBridgeIfEnabled(): Promise<boolean> {');
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at, at + 120)).toContain('stopAgentBridge();');
    expect(codeOnly('core/bridge/agentBridgeKeys.ts')).toContain(
      'export async function rotateBridgeSecret(): Promise<Uint8Array> {'
    );
  });

  it('обещание отзыва произносится вслух — и потому обязано быть правдой', () => {
    expect(SECTION()).toContain("showSuccess('Выдан новый ключ. Прежний больше не действует');");
  });
});

describe('ЗАКРЕПКА', () => {
  it('запуск спрашивает гасящую дверь, экран — трёхсостоятельную', () => {
    const body = BRIDGE();
    expect(body).toContain('export async function bridgeEnabledTry()');
    expect(body).toContain('if (!(await isBridgeEnabled())) return false;');
    expect(body).not.toContain("return (await kvGet(ENABLED_KEY)) === 'true';");
    expect(body).not.toContain('kvGet');
  });

  it('экран заменяет непрочитанную отметку свидетелем из памяти и говорит об этом', () => {
    const body = SECTION();
    expect(body).toContain('const st = await bridgeEnabledTry();');
    const at = body.indexOf('const st = await bridgeEnabledTry();');
    expect(body.slice(at, at + 400)).toContain('isBridgeRunning()');
    expect(body).toContain(MSG_UNREAD);
  });

  it('отзыв ключа спрашивает, жив ли сокет, а не что записано на диске', () => {
    const body = SECTION();
    expect(body).toContain('if (isBridgeRunning() && !(await startAgentBridgeIfEnabled())) {');
    expect(body).not.toContain('if ((await isBridgeEnabled()) && !(await startAgentBridgeIfEnabled())) {');
  });
});
