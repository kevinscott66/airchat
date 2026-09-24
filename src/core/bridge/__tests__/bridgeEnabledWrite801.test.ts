/**
 * Выключенный мост больше не воскресает при следующем запуске (v4.32.801).
 *
 * Дефект. Решение человека писалось через `kvSet` — тот гасит отказ записи и
 * отдаёт `void`. Выключение при этом «удавалось» всегда: рычажок вставал в
 * «выкл», сокет рвался, — а на диске оставалось `true`. При следующем запуске
 * `startAgentBridgeIfEnabled` (App.tsx) читал диск и поднимал подписку заново.
 *
 * Цена. Мост — это канал управления телефоном: чужая сторона по нему читает
 * настройки и щёлкает туннелем. Отзыв доступа не состоялся, и сказать об этом
 * было некому: мост себя ни значком, ни уведомлением не показывает, а рычажок
 * в настройках после перезапуска снова стоит в «вкл» — но заметить это можно,
 * только зайдя туда. Отказ записи приходит чаще всего в первую секунду после
 * запуска и при нехватке места — то есть не в вымышленных условиях.
 *
 * Правка. Запись проверяемая (`kvSetChecked`), отказ бросается наружу. На
 * стороне экрана ловушка с возвратом рычажка была написана заранее и до этой
 * правки была недостижима — бросать было нечему. Порядок в ветке выключения
 * оставлен прежним: сначала запись, потом `stopAgentBridge`, — чтобы сорвав-
 * шееся выключение оставило экран, диск и сокет в одном и том же положении.
 */
import fs from 'fs';
import path from 'path';

/** Что лежит в device-local хранилище: ключ → значение. */
const mockKv: Record<string, string> = {};
/** Ключи, на которых запись отвечает отказом (занятая база, нет места). */
let mockWriteFails = new Set<string>();

const mockKvSetChecked = jest.fn(async (k: string, v: string): Promise<boolean> => {
  if (mockWriteFails.has(k)) return false;
  mockKv[k] = v;
  return true;
});
/** Настоящий kvSet гасит отказ и отдаёт void — мок обязан вести себя так же. */
const mockKvSet = jest.fn(async (k: string, v: string): Promise<void> => {
  await mockKvSetChecked(k, v);
});

jest.mock('../../storage/local', () => ({
  kvGet: jest.fn(async (k: string) => mockKv[k] ?? null),
  kvSet: (k: string, v: string) => mockKvSet(k, v),
  kvSetChecked: (k: string, v: string) => mockKvSetChecked(k, v),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../../config', () => ({
  loadConfig: jest.fn(async () => ({})),
}));

/** Исполнение команд сюда не входит — и тянет за собой весь транспорт. */
jest.mock('../agentBridgeCommands', () => ({
  KNOWN_COMMANDS: ['whoami'],
  runBridgeCommand: jest.fn(),
  parseCommand: jest.fn(() => null),
}));

import { isBridgeEnabled, setBridgeEnabled } from '../agentBridge';

const ENABLED_KEY = 'agent_bridge_enabled';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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
  for (const k of Object.keys(mockKv)) delete mockKv[k];
  mockWriteFails = new Set<string>();
  mockKvSetChecked.mockClear();
  mockKvSet.mockClear();
});

describe('отзыв доступа отвечает за то, что сделал', () => {
  it('сорвавшееся выключение не выдаётся за состоявшееся', async () => {
    await setBridgeEnabled(true);
    expect(await isBridgeEnabled()).toBe(true);

    mockWriteFails.add(ENABLED_KEY);
    await expect(setBridgeEnabled(false)).rejects.toThrow();

    // Обе половины важны вместе. На диске осталось «вкл» — ровно то, что
    // прочитает startAgentBridgeIfEnabled при следующем запуске и поднимет
    // подписку заново. Раньше об этом никто не узнавал: наружу уходило
    // молчаливое «готово».
    expect(mockKv[ENABLED_KEY]).toBe('true');
    expect(await isBridgeEnabled()).toBe(true);
  });

  it('отказ записи при включении тоже признаётся', async () => {
    mockWriteFails.add(ENABLED_KEY);
    await expect(setBridgeEnabled(true)).rejects.toThrow();
    expect(await isBridgeEnabled()).toBe(false);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычное переключение работает', () => {
  it('включение и выключение доходят до диска', async () => {
    await setBridgeEnabled(true);
    expect(mockKv[ENABLED_KEY]).toBe('true');
    expect(await isBridgeEnabled()).toBe(true);

    await setBridgeEnabled(false);
    expect(mockKv[ENABLED_KEY]).toBe('false');
    expect(await isBridgeEnabled()).toBe(false);
  });

  it('удачная запись наружу ничего не бросает', async () => {
    await expect(setBridgeEnabled(true)).resolves.toBeUndefined();
    await expect(setBridgeEnabled(false)).resolves.toBeUndefined();
  });

  it('без ключа в хранилище мост выключен', async () => {
    expect(await isBridgeEnabled()).toBe(false);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('kvSet молчит об отказе — на нём отзыву доступа стоять нельзя', () => {
    const body = codeOnly(read('core/storage/local.ts'));
    expect(body).toContain('export async function kvSet(key: string, value: string): Promise<void> {');
    expect(body).toContain('export async function kvSetChecked(key: string, value: string): Promise<boolean> {');
    // Отказ записи не бросается, а возвращается словом — и только тому, кто
    // спросил проверяемой дверью.
    const at = body.indexOf('export async function kvSetChecked(key: string, value: string): Promise<boolean> {');
    expect(body.slice(at, at + 900)).toContain('return false;');
  });

  it('запуск поднимает мост по записи на диске — уцелевшая «вкл» вернёт его', () => {
    const body = codeOnly(read('App.tsx'));
    expect(body).toContain('m.startAgentBridgeIfEnabled()');
  });

  it('решение о запуске читается ровно из этого ключа', () => {
    const body = codeOnly(read('core/bridge/agentBridge.ts'));
    expect(body).toContain("const ENABLED_KEY = 'agent_bridge_enabled';");
    expect(body).toContain('if (!(await isBridgeEnabled())) return false;');
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('запись проверяемая, и отказ бросается', () => {
    const body = codeOnly(read('core/bridge/agentBridge.ts'));
    const at = body.indexOf('export async function setBridgeEnabled(on: boolean): Promise<void> {');
    expect(at).toBeGreaterThan(0);
    const tail = body.slice(at, at + 260);
    expect(tail).toContain('kvSetChecked(ENABLED_KEY');
    expect(tail).toContain("throw new Error('bridge_enabled_write_failed');");
    // Гасящая дверь из модуля ушла совсем: оставить её значит оставить соблазн.
    expect(body).not.toContain('kvSet(ENABLED_KEY');
  });

  it('экран говорит разное о сорвавшемся включении и сорвавшемся выключении', () => {
    const body = codeOnly(read('ui/components/AgentBridgeSettingsSection.tsx'));
    expect(body).toContain("on ? 'Не удалось включить мост' : 'Мост остался включённым: настройка не сохранилась',");
    expect(body).not.toContain("userErrorText(e, 'Не удалось переключить мост')");
  });

  it('сокет рвётся только после удачной записи', () => {
    const body = codeOnly(read('ui/components/AgentBridgeSettingsSection.tsx'));
    const write = body.indexOf('await setBridgeEnabled(false);');
    const stop = body.indexOf('stopAgentBridge();');
    expect(write).toBeGreaterThan(0);
    // Иначе сорвавшееся выключение оставило бы диск «вкл», а сокет — порванным:
    // мост молчит до перезапуска и оживает после него.
    expect(stop).toBeGreaterThan(write);
  });
});
