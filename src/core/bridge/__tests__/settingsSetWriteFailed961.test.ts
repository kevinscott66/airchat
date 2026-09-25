/**
 * Мост больше не докладывает агенту об успехе непрошедшей записи (v4.32.961).
 *
 * ДЕФЕКТ. `settings.set` писал ключи через `kvSet`, а тот гасит отказ базы и
 * отдаёт `void`. Ответ собирался безусловно: `ok: true`, `applied` — весь
 * присланный список, включая ключи, которые не легли.
 *
 * ЦЕНА. Мост отвечает не человеку, а агенту, и агент по `ok: true` докладывает
 * «сделано». Человек просит вернуть уведомления, база в ту секунду занята —
 * подтверждение он получает, уведомлений нет, и искать причину он будет где
 * угодно, только не в настройке, которую ему подтвердили. Отказ посреди списка
 * ещё хуже: половина ключей записана, половина нет, а в ответе — весь список,
 * и повторить по нему нечего.
 *
 * ПРАВКА. Каждая запись проверяется, исход собирается в два списка. Уцелел
 * хоть один отказ — ответ отказной (`write_failed`), и обе половины названы в
 * тексте: отказной ответ моста не носит `result`, сказать их больше негде.
 *
 * ГРАНИЦЫ. Проверки до записи (чужой ключ, слишком длинное значение) остаются
 * как были и до базы по-прежнему не доходят.
 */

/** Ключи, на записи которых база «занята». */
let mockFailKeys: string[] = [];
/** Что легло. */
const mockKv: Record<string, string> = {};
/** Сколько раз ходили писать. */
let mockWrites = 0;

jest.mock('../../../ui/platformCapabilities', () => ({ OPENFLUX_AVAILABLE: true }));
jest.mock('../../vpn/openFluxController', () => ({
  getOpenFluxRunning: async () => false,
  getOpenFluxSocksAddr: async () => null,
  retryOpenFlux: async () => 'on',
  stopOpenFlux: async () => {},
}));
jest.mock('../../config', () => ({
  loadConfig: async () => ({}),
  saveConfigOverride: async (p: Record<string, unknown>) => p,
}));
jest.mock('../../transport/internet/restartInternetTransport', () => ({
  restartInternetTransport: async () => {},
}));

jest.mock('../../storage/local', () => ({
  kvGet: async (k: string) => mockKv[k] ?? null,
  // Настоящий `kvSet` — это `kvSetChecked` с выброшенным ответом. Держим его
  // здесь именно таким: до правки проверка обязана падать на поведении, а не
  // на том, что заглушка добрее исходника.
  kvSet: async (k: string, v: string) => {
    mockWrites += 1;
    if (mockFailKeys.includes(k)) return;
    mockKv[k] = v;
  },
  kvSetChecked: async (k: string, v: string) => {
    mockWrites += 1;
    if (mockFailKeys.includes(k)) return false;
    mockKv[k] = v;
    return true;
  },
}));

jest.mock('../../logger', () => ({
  log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import { runBridgeCommand, type BridgeReply } from '../agentBridgeCommands';

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const SRC = codeOnly(
  readFileSync(join(__dirname, '..', 'agentBridgeCommands.ts'), 'utf8'),
);

/** Текст отказа — какой бы формы ни был ответ. */
function messageOf(r: BridgeReply): string {
  return String((r as unknown as { message?: unknown }).message ?? '');
}

/** Список применённых — какой бы формы ни был ответ. */
function appliedOf(r: BridgeReply): unknown {
  const res = (r as unknown as { result?: unknown }).result;
  if (!res || typeof res !== 'object') return undefined;
  return (res as { applied?: unknown }).applied;
}

beforeEach(() => {
  mockFailKeys = [];
  mockWrites = 0;
  for (const k of Object.keys(mockKv)) delete mockKv[k];
});

describe('запись не легла — мост говорит об этом, а не «сделано»', () => {
  it('база занята: ответ отказной, а не подтверждение', async () => {
    mockFailKeys = ['notify_dm'];
    const res = await runBridgeCommand({ cmd: 'settings.set', arg: { notify_dm: 'true' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('write_failed');
    expect(mockKv.notify_dm).toBeUndefined();
  });

  it('отказ посреди списка называет обе половины', async () => {
    mockFailKeys = ['notify_calls'];
    const res = await runBridgeCommand({
      cmd: 'settings.set',
      arg: { notify_dm: 'false', notify_calls: 'false', notify_groups: 'false' },
    });
    expect(res.ok).toBe(false);
    const msg = messageOf(res);
    expect(msg).toContain('notify_calls');
    expect(msg).toContain('notify_dm');
    expect(msg).toContain('notify_groups');
    // Записанное действительно записано — отказ не отменяет уже прошедшего.
    expect(mockKv.notify_dm).toBe('false');
    expect(mockKv.notify_calls).toBeUndefined();
  });

  it('не легло ничего — текст не выдумывает записанного', async () => {
    mockFailKeys = ['notify_dm', 'notify_groups'];
    const res = await runBridgeCommand({
      cmd: 'settings.set',
      arg: { notify_dm: 'true', notify_groups: 'true' },
    });
    expect(res.ok).toBe(false);
    expect(messageOf(res)).not.toContain('Записано:');
  });

  it('в подтверждении не числится ключ, который не лёг', async () => {
    mockFailKeys = ['app_font_size'];
    const res = await runBridgeCommand({
      cmd: 'settings.set',
      arg: { app_font_size: 'large', app_theme_mode: 'dark' },
    });
    expect(appliedOf(res)).not.toEqual(expect.arrayContaining(['app_font_size']));
  });
});

/**
 * ПРОВЕРКА НЕ ПУСТАЯ.
 *
 * Отказ нужен ровно там, где запись не прошла. Исправная база обязана вести
 * себя как прежде, иначе мост станет отвечать отказом на работающую правку —
 * а агент по отказу повторяет, и повторять он будет бесконечно.
 */
describe('ПРОВЕРКА НЕ ПУСТАЯ: исправная база отвечает как прежде', () => {
  it('все ключи легли — подтверждение со списком', async () => {
    const res = await runBridgeCommand({
      cmd: 'settings.set',
      arg: { notify_dm: 'false', app_theme_mode: 'dark' },
    });
    expect(res.ok).toBe(true);
    expect(appliedOf(res)).toEqual(['notify_dm', 'app_theme_mode']);
    expect(mockKv.notify_dm).toBe('false');
    expect(mockKv.app_theme_mode).toBe('dark');
  });

  it('предупреждение про оформление осталось', async () => {
    const res = await runBridgeCommand({ cmd: 'settings.set', arg: { app_font_size: 'large' } });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { note?: string }).note).toMatch(/следующем запуске/);
  });

  it('ГРАНИЦА: чужой ключ отсекается до базы', async () => {
    const res = await runBridgeCommand({ cmd: 'settings.set', arg: { seed_phrase: 'нет' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('key_not_allowed');
    expect(mockWrites).toBe(0);
  });

  it('ГРАНИЦА: слишком длинное значение — тоже до базы', async () => {
    const res = await runBridgeCommand({
      cmd: 'settings.set',
      arg: { app_accent_color: 'x'.repeat(65) },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('bad_value');
    expect(mockWrites).toBe(0);
  });
});

describe('форма исходников: настройки пишутся проверенной записью', () => {
  it('в cmdSettingsSet стоит проверяемая дверь, а не немая', () => {
    const at = SRC.indexOf('async function cmdSettingsSet(');
    expect(at).toBeGreaterThan(0);
    const body = SRC.slice(at, SRC.indexOf('async function cmdSettingsGet(', at));
    expect(body).toContain('await kvSetChecked(k, values[k] as string)');
    expect(body).toContain("'write_failed'");
    expect(body).not.toContain('await kvSet(k, values[k] as string)');
  });

  it('немой `kvSet` в модуль больше не ввозится', () => {
    expect(SRC).toContain("import { kvGet, kvSetChecked } from '../storage/local';");
  });
});
