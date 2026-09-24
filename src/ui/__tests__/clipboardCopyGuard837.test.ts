/**
 * Копирование в буфер объявляло успех, не дождавшись буфера (v4.32.837).
 *
 * Дефект. Пять мест писали в буфер и говорили «Скопировано», не проверив,
 * легло ли:
 *  - лента, «Копировать текст» — `void setStringAsync(…).then(() => showSuccess(…))`;
 *  - профиль, кнопка под QR — то же самое;
 *  - профиль, `copyDid` — голый `await` внутри `useAsyncButton`;
 *  - контакты, «Копировать ID» — тот же `.then` без `.catch`;
 *  - мост агента, `copyKey` — голый `await`, а зовут его как `void copyKey()`.
 *
 * Цена. Системе есть чем отказать: на Android запись в буфер приложению не в
 * фокусе запрещена, и `expo-clipboard` в этом случае бросает. У четырёх мест
 * из пяти отказ уходил в неперехваченное отклонение обещания — человек не
 * видел ни «Скопировано», ни «Не удалось». Он шёл вставлять и вставлял то,
 * что лежало в буфере до этого. У `copyDid` `useAsyncButton` отказ ловил, но
 * только в `console.warn`, то есть тоже в никуда.
 *
 * Дороже всего у моста агента: там копируется ключ доступа — строка
 * `airchat-bridge://…`, в которой и секрет, и адрес; предъявителю её больше
 * ничего не нужно. Человек читает предупреждение, соглашается, ничего не
 * происходит — и он отдаёт агенту прежнее содержимое буфера.
 *
 * Правка. Все пять закрыты: `runGuardedOp` там, где место для него есть, и
 * `try/catch` там, где копия сидит внутри собственного `useCallback`. Текст
 * отказа — `COPY_FAILED` из общего словаря, заведённый в v4.32.834 и до сих
 * пор использованный в одном месте из шести. Образец — `UserProfilePeek`,
 * где такой перехват стоял и раньше.
 *
 * Заодно убрана вторая копия `runGuardedOp`: в ленте с v4.32.534 жила своя,
 * а общая появилась в v4.32.546 — одинаковые, кроме метки для журнала,
 * которой у местной не было.
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

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import * as Clipboard from 'expo-clipboard';
import { runGuardedOp } from '../components/runGuardedOp';
import { COPIED_ID, COPY_FAILED } from '../clipboardText';

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockSetString.mockReset();
  mockSetString.mockResolvedValue(undefined);
  mockShowError.mockClear();
  mockShowSuccess.mockClear();
});

describe('отказ буфера доходит до человека', () => {
  /** Точно тот же состав, что у «Копировать ID» в ContactsScreen. */
  const copyId = (did: string): void =>
    runGuardedOp(
      async () => {
        await Clipboard.setStringAsync(did);
        mockShowSuccess(COPIED_ID);
      },
      COPY_FAILED,
      'ui_contacts_copy_id_failed',
    );

  it('в буфер не легло — говорят об этом и не врут про успех', async () => {
    mockSetString.mockRejectedValue(new Error('Clipboard is not available in background'));
    copyId('did:key:zAbc');
    await settle();
    expect(mockShowSuccess).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledWith(COPY_FAILED);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: легло — подтверждают и молчат об ошибках', async () => {
    copyId('did:key:zAbc');
    await settle();
    expect(mockSetString).toHaveBeenCalledWith('did:key:zAbc');
    expect(mockShowSuccess).toHaveBeenCalledWith(COPIED_ID);
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('машинный текст ошибки на экран не выносят', async () => {
    mockSetString.mockRejectedValue(new Error('NSPasteboard access denied'));
    copyId('did:key:zAbc');
    await settle();
    expect(mockShowError).toHaveBeenCalledWith(COPY_FAILED);
    expect(mockShowError.mock.calls[0][0]).not.toContain('NSPasteboard');
  });
});

const src = (...p: string[]): string => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
/** Только код: свой же разбор не должен себя подтверждать. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('слово для отказа заведено — оставалось им воспользоваться', () => {
    expect(codeOnly(src('clipboardText.ts'))).toContain("export const COPY_FAILED = ");
  });

  it('образец перехвата стоял рядом всё это время', () => {
    const peek = codeOnly(src('components', 'UserProfilePeek.tsx'));
    const at = peek.indexOf('const handleCopyId = useCallback(async () => {');
    expect(at).toBeGreaterThan(0);
    const body = peek.slice(at, at + 400);
    expect(body).toContain('await Clipboard.setStringAsync(');
    expect(body).toContain('showError(COPY_FAILED);');
  });

  it('useAsyncButton гасит отказ в консоль — человеку от этого ничего', () => {
    const hook = codeOnly(
      fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'hooks', 'useAsyncButton.ts'), 'utf8'),
    );
    expect(hook).toContain("console.warn('[useAsyncButton] Unhandled error:', e);");
    expect(hook).not.toContain('showError');
  });

  it('ключ моста — предъявительский, и об этом сказано на экране', () => {
    const sec = src('components', 'AgentBridgeSettingsSection.tsx');
    expect(sec).toContain('Ключ уйдёт в буфер обмена');
    expect(codeOnly(sec)).toContain('await Clipboard.setStringAsync(accessKey);');
  });
});

describe('форма исходников', () => {
  /** Вырезать тело названной функции — пин не должен ловить однофамильца. */
  const bodyAt = (s: string, needle: string, len: number): string => {
    const at = s.indexOf(needle);
    expect(at).toBeGreaterThan(0);
    return s.slice(at, at + len);
  };

  it('лента: копия текста закрыта, и словарь отказа у неё свой', () => {
    const feed = codeOnly(src('screens', 'FeedScreen.tsx'));
    const body = bodyAt(feed, "row('copy-outline', t('feed.menuCopyText')", 600);
    expect(body).toContain('runGuardedOp(async () => {');
    expect(body).toContain("t('feed.menuCopyFailed')");
    const ru = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'i18n', 'ru.json'), 'utf8'),
    ) as { feed: Record<string, string> };
    expect(ru.feed.menuCopyFailed).toBe(COPY_FAILED);
  });

  it('лента больше не держит свою копию runGuardedOp', () => {
    const feed = codeOnly(src('screens', 'FeedScreen.tsx'));
    expect(feed).not.toContain('function runGuardedOp(');
    expect(feed).toContain("import { runGuardedOp } from '../components/runGuardedOp';");
  });

  it('профиль: обе кнопки копирования закрыты', () => {
    const prof = codeOnly(src('screens', 'ProfileScreen.tsx'));
    const did = bodyAt(prof, 'const copyDid = async (): Promise<void> => {', 400);
    expect(did).toContain('showError(COPY_FAILED);');
    const btn = bodyAt(prof, 'runGuardedOp(async () => {', 300);
    expect(btn).toContain('await Clipboard.setStringAsync(buildContactLink(did).web);');
    expect(btn).toContain('COPY_FAILED');
    expect(prof).not.toContain('void Clipboard.setStringAsync(');
  });

  it('контакты: «Копировать ID» закрыт', () => {
    const cont = codeOnly(src('screens', 'ContactsScreen.tsx'));
    const body = bodyAt(cont, 'runGuardedOp(async () => {', 300);
    expect(body).toContain('await Clipboard.setStringAsync(did);');
    expect(body).toContain('COPY_FAILED');
    expect(cont).not.toContain('void Clipboard.setStringAsync(');
  });

  it('мост агента: отказ показывают и в журнал кладут, успех — только после записи', () => {
    const sec = codeOnly(src('components', 'AgentBridgeSettingsSection.tsx'));
    const body = bodyAt(sec, 'const copyKey = useCallback(async () => {', 700);
    const write = body.indexOf('await Clipboard.setStringAsync(accessKey);');
    const fail = body.indexOf('showError(COPY_FAILED);');
    const ok = body.indexOf('showSuccess(COPIED_TEXT);');
    expect(write).toBeGreaterThan(0);
    expect(fail).toBeGreaterThan(write);
    expect(ok).toBeGreaterThan(fail);
    expect(body).toContain("log.warn('agent_bridge_key_copy_failed'");
    // Выход из ловушки обязателен: иначе за отказом шло бы «Скопировано».
    expect(body.slice(fail, ok)).toContain('return;');
  });

  it('своих литералов про неудачное копирование не осталось', () => {
    for (const f of [
      ['components', 'modals', 'profile', 'LinkProofSheet.tsx'],
      ['components', 'UserProfilePeek.tsx'],
      ['screens', 'ProfileScreen.tsx'],
      ['screens', 'ContactsScreen.tsx'],
    ]) {
      expect(codeOnly(src(...f))).not.toContain("'Не удалось скопировать'");
    }
  });
});
