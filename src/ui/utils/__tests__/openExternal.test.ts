/**
 * Рэтчет к v4.32.535: нажатие на ссылку либо открывает её, либо объясняет,
 * почему нет.
 *
 * Раньше тринадцать мест открывали адрес сами, и одиннадцать из них глушили
 * отказ пустым перехватом `.catch(() => {})`, а два не перехватывали вовсе.
 * Тесты закрепляют и поведение единой точки выхода, и то, что мест снова не
 * стало тринадцать.
 */
import fs from 'fs';
import path from 'path';
import { Linking, Platform } from 'react-native';

import { showError } from '../../components/userFeedback';
import { openExternal, openMapAt, openTypedExternal } from '../openExternal';

jest.mock('react-native', () => ({
  Linking: { openURL: jest.fn(), canOpenURL: jest.fn() },
  Platform: { OS: 'android' },
}));
jest.mock('../../components/userFeedback', () => ({ showError: jest.fn() }));
jest.mock('../../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const openURL = Linking.openURL as unknown as jest.Mock;
const canOpenURL = Linking.canOpenURL as unknown as jest.Mock;
const errorShown = showError as unknown as jest.Mock;

const OSM = 'https://www.openstreetmap.org/?mlat=55.75&mlon=37.61#map=16/55.75/37.61';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  openURL.mockResolvedValue(undefined);
  canOpenURL.mockResolvedValue(true);
});

describe('openExternal', () => {
  it('открывает пригодный адрес и молчит', async () => {
    openExternal('https://example.com/a', 'test');
    await flush();
    expect(openURL).toHaveBeenCalledWith('https://example.com/a');
    expect(errorShown).not.toHaveBeenCalled();
  });

  it('непригодный адрес не открывает, но и не молчит', async () => {
    openExternal('javascript:alert(1)', 'test');
    await flush();
    expect(openURL).not.toHaveBeenCalled();
    expect(errorShown).toHaveBeenCalledTimes(1);
    expect(errorShown.mock.calls[0][0]).toContain('небезопасно');
  });

  it('отказ системы человек видит, а не гадает', async () => {
    openURL.mockRejectedValue(new Error('no activity'));
    openExternal('https://example.com', 'test');
    await flush();
    expect(errorShown).toHaveBeenCalledTimes(1);
    expect(errorShown.mock.calls[0][0]).toContain('Не удалось открыть ссылку');
  });

  it('вызывающий может назвать отказ по-своему', async () => {
    openURL.mockRejectedValue(new Error('no activity'));
    openExternal('https://example.com/f.pdf', 'doc', 'Не удалось открыть файл');
    await flush();
    expect(errorShown).toHaveBeenCalledWith('Не удалось открыть файл');
  });

  it('адрес в журнал не пишется', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { log } = require('../../../core/logger');
    openExternal('https://secret.example.com/token', 'test');
    await flush();
    const serialized = JSON.stringify(log.warn.mock.calls) + JSON.stringify(log.info.mock.calls);
    expect(serialized).not.toContain('secret.example.com');
  });
});

describe('openTypedExternal', () => {
  it('владельцу профиля прощается адрес без схемы', async () => {
    openTypedExternal('example.com', 'profile_site');
    await flush();
    expect(openURL.mock.calls[0][0]).toMatch(/^https:\/\/example\.com\/?$/);
  });

  it('но не любая строка', async () => {
    openTypedExternal('   ', 'profile_site');
    await flush();
    expect(openURL).not.toHaveBeenCalled();
    expect(errorShown).toHaveBeenCalledTimes(1);
  });
});

describe('openMapAt', () => {
  it('негодные координаты — отказ вслух, без обращения к системе', async () => {
    openMapAt(NaN, 37.61);
    await flush();
    expect(openURL).not.toHaveBeenCalled();
    expect(errorShown).toHaveBeenCalledWith('Не удалось открыть карту');
  });

  it('на Android сначала приложение карт, а не браузер', async () => {
    openMapAt(55.75, 37.61);
    await flush();
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL.mock.calls[0][0]).toBe('geo:55.75,37.61?q=55.75%2C37.61');
    expect(errorShown).not.toHaveBeenCalled();
  });

  it('на iOS — штатные «Карты»', async () => {
    Platform.OS = 'ios';
    openMapAt(55.75, 37.61);
    await flush();
    expect(openURL.mock.calls[0][0]).toContain('maps.apple.com');
  });

  it('нет приложения карт — открывается браузер', async () => {
    canOpenURL.mockResolvedValue(false);
    openMapAt(55.75, 37.61);
    await flush();
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL.mock.calls[0][0]).toBe(OSM);
    expect(errorShown).not.toHaveBeenCalled();
  });

  it('приложение карт сорвалось — это ещё не отказ показать точку', async () => {
    canOpenURL.mockRejectedValue(new Error('bad scheme'));
    openMapAt(55.75, 37.61);
    await flush();
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL.mock.calls[0][0]).toBe(OSM);
    expect(errorShown).not.toHaveBeenCalled();
  });

  it('сорвались обе попытки — человек об этом узнаёт', async () => {
    openURL.mockRejectedValue(new Error('nope'));
    openMapAt(55.75, 37.61);
    await flush();
    expect(errorShown).toHaveBeenCalledWith('Не удалось открыть карту');
  });

  it('вне Android и iOS приложение карт даже не спрашивают', async () => {
    Platform.OS = 'web';
    openMapAt(55.75, 37.61);
    await flush();
    expect(canOpenURL).not.toHaveBeenCalled();
    expect(openURL).toHaveBeenCalledWith(OSM);
  });
});

// ── Проверка не пустая: форма исходников ────────────────────────────────────

const SRC = path.join(__dirname, '..', '..', '..');

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

const REWIRED = [
  'ui/screens/ProfileScreen.tsx',
  'ui/screens/GroupsScreen.tsx',
  'ui/screens/ChatScreen.tsx',
  'ui/screens/chat-components/LiveLocationBubble.tsx',
  'ui/screens/chat-components/LocationBubble.tsx',
  'ui/screens/chat-components/DocBubble.tsx',
  'ui/screens/chat-components/text/FormattedText.tsx',
  'ui/screens/groups-components/text/GrpFormattedText.tsx',
  'ui/components/RichText.tsx',
  'ui/components/LocationMessage.tsx',
  'ui/components/modals/chat/ChatSharedMediaModal.tsx',
  'ui/components/modals/groups/GroupSharedMediaModal.tsx',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

describe('выход наружу остался единственным', () => {
  it('никто, кроме openExternal, не зовёт Linking.openURL', () => {
    const guilty = sources()
      .filter((f) => /Linking\.(open|canOpen)URL\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(guilty).toEqual(['ui/utils/openExternal.ts']);
  });

  it('адрес OpenStreetMap собран в одном месте', () => {
    const guilty = sources()
      .filter((f) => fs.readFileSync(f, 'utf8').includes('openstreetmap.org/?mlat='))
      .map((f) => path.relative(SRC, f));
    expect(guilty).toEqual(['core/net/mapLink.ts']);
  });

  it('geo: и maps.apple.com тоже собраны в одном месте', () => {
    const guilty = sources()
      .filter((f) => /`geo:\$\{|maps\.apple\.com/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(guilty).toEqual(['core/net/mapLink.ts']);
  });

  it('переписанные места больше не держат Linking у себя', () => {
    for (const rel of REWIRED) {
      expect(read(rel)).not.toMatch(/^\s*Linking,\s*$/m);
      expect(read(rel)).not.toMatch(/\bLinking\b.*from 'react-native'/);
    }
  });

  it('каждое переписанное место зовёт общую точку выхода', () => {
    for (const rel of REWIRED) {
      expect(read(rel)).toMatch(/open(External|TypedExternal|MapAt)\(/);
    }
  });

  it('ссылки соцсетей в профиле больше не уходят без перехвата', () => {
    const profile = read('ui/screens/ProfileScreen.tsx');
    expect(profile).toContain("openExternal(`https://twitter.com/${twitterHandle}`, 'profile_twitter')");
    expect(profile).toContain("openExternal(`https://github.com/${githubHandle}`, 'profile_github')");
  });

  it('отказ проверки адреса после нажатия не молчит', () => {
    const src = read('ui/utils/openExternal.ts');
    const rejected = src.indexOf('ui_open_external_rejected');
    const shown = src.indexOf('showError(NOT_A_LINK)');
    expect(rejected).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(rejected);
  });

  it('в карте сначала пробуют приложение, потом браузер', () => {
    const src = read('ui/utils/openExternal.ts');
    expect(src.indexOf('canOpenURL(preferred)')).toBeLessThan(src.indexOf('openURL(web)'));
  });
});
