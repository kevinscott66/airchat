/**
 * Автоудаление по умолчанию перестало верить в свою запись (v4.32.811).
 *
 * Дефект. `setDefaultDisappearMsFor` ставила кэш ПЕРЕД записью, а записывала
 * через `scopedKvSetFor` — `Promise<void>` поверх проверяемой записи. Ответ
 * базы терялся дважды: обёртка его роняла, а сама функция отдавала `void`, и
 * экран настроек писал значение через `void setDefaultDisappearMs(...)`.
 *
 * Цена. Пока приложение не перезапускали, всё выглядело сделанным: кэш
 * отвечал новым значением на каждое `touchConversation`, то есть новые
 * разговоры и правда получали выбранный таймер. После перезапуска кэш
 * собирался с диска, а там лежало прежнее. Это единственная настройка, по
 * которой переписка УДАЛЯЕТСЯ, и опасны обе стороны. Поставил «1 день»,
 * запись не легла — новые разговоры живут вечно, а человек уверен, что они
 * исчезают, и пишет соответственно. Поставил «Выкл», запись не легла — новые
 * разговоры продолжают удаляться, и узнают об этом, когда искать удалённое
 * уже негде.
 *
 * Правка. Запись идёт через `scopedKvSetCheckedFor`, кэш ставится только
 * после удачной, а при отказе сбрасывается — ответ в памяти обязан совпадать
 * с диском даже ценой лишнего чтения. `false` доходит до экрана, и выбор там
 * возвращается на прежнее значение общим правилом `applyPref`.
 */
const mockKv: Record<string, string> = {};
/** Ключи, запись которых база не выполняет. */
const mockFailWrites = new Set<string>();

jest.mock('../local', () => ({
  kvTryGet: jest.fn(async (k: string) => ({ value: mockKv[k] ?? null })),
  kvSet: jest.fn(async (k: string, v: string) => { mockKv[k] = v; }),
  kvSetChecked: jest.fn(async (k: string, v: string) => {
    if (mockFailWrites.has(k)) return false;
    mockKv[k] = v;
    return true;
  }),
  kvDelete: jest.fn(async (k: string) => { delete mockKv[k]; }),
}));

let mockActiveProfileId = 1;
jest.mock('../../identity/profileManager', () => ({
  profileManager: { getActiveProfile: () => ({ id: mockActiveProfileId }) },
}));

import fs from 'fs';
import path from 'path';

import {
  getDefaultDisappearMsFor,
  setDefaultDisappearMs,
  setDefaultDisappearMsFor,
} from '../defaultDisappear';
import { DEFAULT_AUTO_DELETE_KEY } from '../autoDeletePolicy';

const KEY = DEFAULT_AUTO_DELETE_KEY;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

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

/** Кэш живёт весь файл, поэтому каждой проверке достаётся свежий номер. */
let lastPid = 300;
const pid = (): number => ++lastPid;

beforeEach(() => {
  for (const k of Object.keys(mockKv)) delete mockKv[k];
  mockFailWrites.clear();
  mockActiveProfileId = 1;
});

describe('несостоявшаяся запись не выдаёт себя за сделанную', () => {
  it('удачная запись отвечает утвердительно', async () => {
    const p = pid();
    expect(await setDefaultDisappearMsFor(p, HOUR)).toBe(true);
    expect(mockKv[`p${p}:${KEY}`]).toBe(String(HOUR));
  });

  it('отказ базы отвечает false, а не молчанием', async () => {
    const p = pid();
    mockFailWrites.add(`p${p}:${KEY}`);
    expect(await setDefaultDisappearMsFor(p, DAY)).toBe(false);
  });

  it('несостоявшееся включение не обещает удаления через кэш', async () => {
    // Самое дорогое: человек поставил таймер, запись не легла — и до
    // перезапуска кэш уверял бы, что новые разговоры исчезнут сами.
    const p = pid();
    mockFailWrites.add(`p${p}:${KEY}`);
    await setDefaultDisappearMsFor(p, DAY);
    expect(await getDefaultDisappearMsFor(p)).toBeNull();
  });

  it('несостоявшееся выключение не отменяет удаления через кэш', async () => {
    // Обратная сторона: человек выключил автоудаление, запись не легла — и
    // переписка продолжала бы исчезать, а кэш отвечал бы «выключено».
    const p = pid();
    await setDefaultDisappearMsFor(p, HOUR);
    mockFailWrites.add(`p${p}:${KEY}`);
    expect(await setDefaultDisappearMsFor(p, null)).toBe(false);
    expect(await getDefaultDisappearMsFor(p)).toBe(HOUR);
  });

  it('кэш после отказа берёт ответ у базы, а не хранит выдумку', async () => {
    const p = pid();
    await setDefaultDisappearMsFor(p, HOUR);
    mockFailWrites.add(`p${p}:${KEY}`);
    await setDefaultDisappearMsFor(p, DAY);
    // Запись на диске прежняя — и чтение обязано отдать именно её.
    expect(mockKv[`p${p}:${KEY}`]).toBe(String(HOUR));
    expect(await getDefaultDisappearMsFor(p)).toBe(HOUR);
  });

  it('активный профиль отвечает так же', async () => {
    mockActiveProfileId = pid();
    expect(await setDefaultDisappearMs(HOUR)).toBe(true);
    mockFailWrites.add(`p${mockActiveProfileId}:${KEY}`);
    expect(await setDefaultDisappearMs(null)).toBe(false);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная работа не менялась', () => {
  it('значение пишется, читается и кэшируется', async () => {
    const p = pid();
    await setDefaultDisappearMsFor(p, DAY);
    expect(await getDefaultDisappearMsFor(p)).toBe(DAY);
    // Второе чтение идёт из кэша: база к этому моменту может быть занята.
    delete mockKv[`p${p}:${KEY}`];
    expect(await getDefaultDisappearMsFor(p)).toBe(DAY);
  });

  it('ноль и отрицательное значат «выключено»', async () => {
    const p = pid();
    await setDefaultDisappearMsFor(p, null);
    expect(mockKv[`p${p}:${KEY}`]).toBe('0');
    expect(await getDefaultDisappearMsFor(p)).toBeNull();
  });

  it('значение остаётся при своём профиле', async () => {
    const mine = pid();
    const other = pid();
    await setDefaultDisappearMsFor(mine, DAY);
    expect(await getDefaultDisappearMsFor(other)).toBeNull();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('значение читает не только экран настроек — по нему ставится таймер', () => {
    // Иначе речь шла бы о надписи в настройках; здесь речь о том, исчезнет
    // переписка или нет.
    const local = codeOnly(read('core', 'storage', 'local.ts'));
    expect(local).toContain('const defaultDisappear = await getDefaultDisappearMsFor(t.ownerProfileId);');
    expect(local).toContain('defaultMs: defaultDisappear,');
  });

  it('scopedKvSetFor по-прежнему роняет ответ, который знает', () => {
    const scoped = codeOnly(read('core', 'storage', 'profileScopedKv.ts'));
    expect(scoped).toContain(
      'export async function scopedKvSetFor(pid: number, key: string, value: string): Promise<void> {\n  await scopedKvSetCheckedFor(pid, key, value);\n}',
    );
  });
});

describe('форма исходников: кэш после записи, экран с откатом', () => {
  it('запись проверяемая и кэш ставится только после удачной', () => {
    const s = codeOnly(read('core', 'storage', 'defaultDisappear.ts'));
    expect(s).toContain(
      'const written = await scopedKvSetCheckedFor(profileId, DEFAULT_AUTO_DELETE_KEY, String(ms ?? 0));',
    );
    expect(s).toContain('if (written) cache.set(profileId, ms != null && ms > 0 ? ms : null);');
    expect(s).toContain('else cache.delete(profileId);');
    expect(s).not.toContain('await scopedKvSetFor(profileId, DEFAULT_AUTO_DELETE_KEY');
  });

  it('обе двери объявлены отвечающими', () => {
    const s = codeOnly(read('core', 'storage', 'defaultDisappear.ts'));
    expect(s).toContain('): Promise<boolean> {\n  const written = await scopedKvSetCheckedFor(');
    expect(s).toContain(
      'export async function setDefaultDisappearMs(ms: number | null): Promise<boolean> {\n  return setDefaultDisappearMsFor(activeProfileId(), ms);',
    );
  });

  it('экран возвращает выбор на прежнее значение, а не на умолчание', () => {
    const s = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
    expect(s).toContain('const chooseDefaultAutoDelete = useCallback((ms: number | null): void => {');
    expect(s).toContain('const prev = defaultAutoDeleteMs;');
    expect(s).toContain(
      'void applyPref(() => setDefaultDisappearMs(ms), () => setDefaultAutoDeleteMs(prev));',
    );
    expect(s).not.toContain('void setDefaultDisappearMs(null); }');
    expect(s).toContain("{ text: '1 день', onPress: () => chooseDefaultAutoDelete(86_400_000) },");
  });
});
