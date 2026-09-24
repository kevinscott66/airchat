/**
 * v4.32.883 — тринадцать мест копировали устаревшим способом и врали об успехе.
 *
 * Дефект: v4.32.837 закрыла пять копий на `expo-clipboard`, но мимо прошли те,
 * что писали в буфер через `Clipboard.setString` из react-native — меню
 * сообщения в личной переписке и в группе, ссылка на сообщение, результаты
 * опроса, адрес группы, QR приглашения, копирование выделения целиком. API
 * устаревший (react-native ругается в журнал и обещает его убрать), работает
 * синхронно и ничего не возвращает — поэтому «Скопировано» показывалось
 * строкой ниже всегда, независимо от того, легло ли что-нибудь в буфер.
 * Тринадцатым местом была общая папка чата: там звали `void setStringAsync`
 * без единого `catch` и тут же рапортовали об успехе.
 *
 * Цена: человек закрывает экран, идёт вставлять — а там прежнее содержимое
 * буфера. Вставляет он обычно не туда, откуда копировал, так что вернуться
 * за текстом сложнее, чем скопировать заново. На Android запись в буфер
 * приложению не в фокусе система запрещает, и это не редкость.
 *
 * Правка: один помощник `copyText(text, okText)` на `expo-clipboard` —
 * ждёт запись, подтверждает только после неё, отказ называет COPY_FAILED и
 * кладёт в журнал. Устаревший импорт из react-native в приложении не остался
 * ни одного.
 */
import fs from 'fs';
import path from 'path';

const mockSetString = jest.fn<Promise<void>, [string]>();
jest.mock('expo-clipboard', () => ({
  setStringAsync: (v: string) => mockSetString(v),
  getStringAsync: jest.fn(async () => ''),
}));

const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();
jest.mock('../components/userFeedback', () => ({
  showError: (m: string) => mockShowError(m),
  showSuccess: (m: string) => mockShowSuccess(m),
}));

const mockWarn = jest.fn();
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: (m: string, meta?: unknown) => mockWarn(m, meta), debug: jest.fn(), error: jest.fn() },
}));

import { copyText } from '../copyText';
import { COPIED_LINK, COPIED_TEXT, COPY_FAILED } from '../clipboardText';

beforeEach(() => {
  mockSetString.mockReset();
  mockSetString.mockResolvedValue(undefined);
  mockShowError.mockClear();
  mockShowSuccess.mockClear();
  mockWarn.mockClear();
});

describe('v4.32.883 — «Скопировано» только после буфера', () => {
  describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
    it('легло — подтверждают ровно тем текстом, что просили', async () => {
      await expect(copyText('https://air.chat/m/1', COPIED_LINK)).resolves.toBe(true);
      expect(mockSetString).toHaveBeenCalledWith('https://air.chat/m/1');
      expect(mockShowSuccess).toHaveBeenCalledWith(COPIED_LINK);
      expect(mockShowError).not.toHaveBeenCalled();
    });

    it('слово для отказа давно заведено в общем словаре', () => {
      expect(COPY_FAILED.length).toBeGreaterThan(5);
      expect(COPIED_TEXT).not.toBe(COPY_FAILED);
    });
  });

  describe('отказ не выдают за успех', () => {
    it('буфер отказал — «Скопировано» не показывают', async () => {
      mockSetString.mockRejectedValue(new Error('Clipboard is not available in background'));
      await expect(copyText('секрет', COPIED_TEXT)).resolves.toBe(false);
      expect(mockShowSuccess).not.toHaveBeenCalled();
      expect(mockShowError).toHaveBeenCalledWith(COPY_FAILED);
    });

    it('отказ уходит в журнал, а не в пустоту', async () => {
      mockSetString.mockRejectedValue(new Error('NSPasteboard access denied'));
      await copyText('текст', COPIED_TEXT);
      expect(mockWarn).toHaveBeenCalledWith('clipboard_copy_failed', expect.anything());
    });

    it('машинный текст ошибки на экран не выносят', async () => {
      mockSetString.mockRejectedValue(new Error('NSPasteboard access denied'));
      await copyText('текст', COPIED_TEXT);
      expect(mockShowError).toHaveBeenCalledWith(COPY_FAILED);
      expect(String(mockShowError.mock.calls[0][0])).not.toContain('NSPasteboard');
    });

    it('обещание не отклоняется — звать через void безопасно', async () => {
      mockSetString.mockRejectedValue(new Error('denied'));
      await expect(copyText('т', COPIED_TEXT)).resolves.toBe(false);
    });
  });
});

const SRC_ROOT = path.join(__dirname, '..', '..');

/** Все исходники приложения, кроме тестов. */
function appFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === '__mocks__') continue;
      appFiles(p, acc);
    } else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const FILES = appFiles(SRC_ROOT);

/** Только код: в докблоках устаревшее имя упоминать можно и нужно. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('исходников набралось достаточно — обход не пустой', () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  it('образец правильной записи стоит с v4.32.837', () => {
    const peek = codeOnly(fs.readFileSync(path.join(SRC_ROOT, 'ui', 'components', 'UserProfilePeek.tsx'), 'utf8'));
    expect(peek).toContain('await Clipboard.setStringAsync(');
    expect(peek).toContain('showError(COPY_FAILED);');
  });
});

describe('устаревшего буфера в приложении не осталось', () => {
  it('ни один файл не берёт Clipboard из react-native', () => {
    const guilty = FILES.filter((f) => {
      const code = codeOnly(fs.readFileSync(f, 'utf8'));
      const imports = code.match(/import\s*\{[^}]*\}\s*from\s*'react-native'/gs) ?? [];
      return imports.some((i) => /\bClipboard\b/.test(i));
    });
    expect(guilty.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });

  it('ни один файл не зовёт Clipboard.setString', () => {
    const guilty = FILES.filter((f) => /Clipboard\.setString\(/.test(codeOnly(fs.readFileSync(f, 'utf8'))));
    expect(guilty.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });

  it('рядом с записью в буфер нет безусловного «Скопировано»', () => {
    const guilty = FILES.filter((f) => {
      const code = codeOnly(fs.readFileSync(f, 'utf8'));
      // `void …setStringAsync(…); showSuccess(…)` — успех объявлен, не дождавшись записи.
      return /void\s+[\w.]*setStringAsync\([^;]*\);\s*showSuccess\(/.test(code);
    });
    expect(guilty.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });
});

describe('места переведены на общий помощник', () => {
  const CALLERS = [
    ['личная переписка', path.join('ui', 'screens', 'ChatScreen.tsx')],
    ['группы', path.join('ui', 'screens', 'GroupsScreen.tsx')],
    ['опрос в группе', path.join('ui', 'screens', 'groups-components', 'PollBubble.tsx')],
    ['опрос в личной', path.join('ui', 'screens', 'chat-components', 'DmPollBubble.tsx')],
    ['шапка группы', path.join('ui', 'screens', 'groups-components', 'GroupProfileHeader.tsx')],
    ['QR приглашения', path.join('ui', 'components', 'modals', 'groups', 'GroupQrModal.tsx')],
    ['общая папка чата', path.join('ui', 'components', 'modals', 'chat', 'ChatSharedMediaModal.tsx')],
  ] as const;

  it.each(CALLERS)('%s зовёт copyText', (_name, rel) => {
    const code = codeOnly(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8'));
    expect(code).toContain("from '");
    expect(code).toMatch(/import \{ copyText \} from '[^']*copyText';/);
    expect(code).toContain('copyText(');
  });

  it('QR закрывается только после того, как скопировал', () => {
    const qr = codeOnly(
      fs.readFileSync(path.join(SRC_ROOT, 'ui', 'components', 'modals', 'groups', 'GroupQrModal.tsx'), 'utf8'),
    );
    expect(qr).toContain('void copyText(inviteLinkQr, COPIED_LINK).then(onClose);');
  });
});
