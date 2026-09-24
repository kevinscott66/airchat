/**
 * Флаги диалога перестали глушить отказ записи (v4.32.838).
 *
 * Дефект. Пять писателей в `conversations` — черновик, закрепление, архив,
 * закреплённое сообщение, цветная метка — целиком лежали в `try`, в ловушке
 * стоял `log.warn`, и на этом всё: подпись `Promise<void>` другого способа
 * признаться не оставляет, наружу отказ уходил успехом. Та же семья, что
 * счётчик непрочитанных, который закрыли в v4.32.836, — только руки до неё
 * тогда не дошли.
 *
 * Цена. Все семь нажатий в списке переписок записаны одинаково:
 * `void setConversationX(…).then(loadData)` без `.catch`. Раз отказ приходил
 * успехом, `loadData` наступал — перечитывал базу и возвращал строку в
 * прежний вид. Человек видел ровно то, что до нажатия: закрепление не
 * закрепилось, архив не убрал, метка не появилась. Это читается как «не
 * попал по кнопке», поэтому он жал снова — и снова.
 *
 * Отдельно «архивировать прочитанные»: там `Promise.all` по всем прочитанным
 * перепискам. Отказ одной записи в `all` отменяет всё продолжение, то есть
 * `loadData` не наступал бы вовсе, и остальные — уже архивные в базе —
 * остались бы показанными неархивными до следующего захода.
 *
 * И цветная метка: чужое значение выходило тихим `return`, то есть выглядело
 * применённым.
 *
 * Правка. Журнальная строка остаётся (по ней ищут причину), следом `throw e`.
 * Семь вызовов обёрнуты `runGuardedOp` с готовым текстом; пачка переведена на
 * `allSettled` и считает отказавшие. Осознанного молчания два: зеркальная
 * запись в `dmPinSync` (источник правды — список в kv, и закрепление там уже
 * состоялось) и черновик в чате (пишется сам во время набора).
 *
 * Стенд — тот же, что у `convUnreadSwallow836.test.ts`.
 */
import fs from 'fs';
import path from 'path';

type Run = { changes: number; lastInsertRowId: number };

/** Отказ на записи флагов — точечно, чтобы миграции жили. */
let mockFlagWriteFails = false;
/** Сколько первых записей флага пропустить до отказа: нужно для пачки. */
let mockFailAfter = 0;
let mockWrites: string[] = [];

function mockIsFlagWrite(sql: string): boolean {
  const s = sql.replace(/\s+/g, ' ').trim();
  return /conversations/.test(s) && /pinned|archived|color_tag|draft_text/.test(s);
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string): Promise<Run> => {
      if (mockIsFlagWrite(sql)) {
        if (mockFlagWriteFails && mockWrites.length >= mockFailAfter) {
          throw new Error('SQLITE_BUSY: database is locked');
        }
        mockWrites.push(sql.replace(/\s+/g, ' ').trim());
      }
      return { changes: 1, lastInsertRowId: 1 };
    }),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => null),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('../secureStoreQueued', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  AT_REST_COLUMNS: [],
  getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
  encryptAtRestString: jest.fn((v: string) => v),
  encryptAtRestNullable: jest.fn((v: string | null) => v),
  decryptAtRestString: jest.fn((v: string) => v),
  decryptAtRestNullable: jest.fn((v: string | null) => v),
  isAtRestCiphertext: jest.fn(() => false),
  resetDataEncryptionKeyCache: jest.fn(),
}));

const mockShowError = jest.fn();
jest.mock('../../../ui/components/userFeedback', () => ({
  showError: (m: string) => mockShowError(m),
  showSuccess: jest.fn(),
}));

import {
  kvDelete,
  setConversationArchived,
  setConversationColorTag,
  setConversationDraft,
  setConversationPinned,
  setConversationPinnedMessage,
} from '../local';
import { runGuardedOp } from '../../../ui/components/runGuardedOp';
import { userErrorText } from '../../../ui/components/userErrorText';

const PEER = 'peer-pub-b64';
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** База поднимается лениво; открываем её до того, как включён отказ. */
beforeAll(async () => {
  await kvDelete('warmup');
});

beforeEach(() => {
  mockFlagWriteFails = false;
  mockFailAfter = 0;
  mockWrites = [];
  mockShowError.mockClear();
});

describe('отказ записи доходит до вызывающего', () => {
  beforeEach(() => {
    mockFlagWriteFails = true;
  });

  it('закрепление диалога сообщает о провале', async () => {
    await expect(setConversationPinned(PEER, 1, true)).rejects.toThrow('SQLITE_BUSY');
  });

  it('архивирование — тоже', async () => {
    await expect(setConversationArchived(PEER, 1, true)).rejects.toThrow('SQLITE_BUSY');
  });

  it('цветная метка — тоже', async () => {
    await expect(setConversationColorTag(PEER, 1, '#E53935')).rejects.toThrow('SQLITE_BUSY');
  });

  it('закреплённое сообщение — тоже', async () => {
    await expect(setConversationPinnedMessage(PEER, 1, 'msg-1')).rejects.toThrow('SQLITE_BUSY');
  });

  it('черновик — тоже (молчит уже вызывающий, а не запись)', async () => {
    await expect(setConversationDraft(PEER, 1, 'недописанное')).rejects.toThrow('SQLITE_BUSY');
  });

  it('чужая метка — отказ, а не тихий выход', async () => {
    mockFlagWriteFails = false;
    await expect(setConversationColorTag(PEER, 1, 'javascript:alert(1)')).rejects.toThrow();
    expect(mockWrites).toHaveLength(0);
  });
});

describe('цена дефекта: список перерисовывали по несостоявшейся записи', () => {
  /** Точно тот же состав, что у свайпа «закрепить» в ChatListScreen. */
  const pinAndReload = (loadData: () => Promise<void>): void =>
    runGuardedOp(
      async () => {
        await setConversationPinned(PEER, 1, true);
        await loadData();
      },
      'Не удалось закрепить',
      'chat_list_swipe_pin_failed',
    );

  it('запись не легла — список не перечитывают и говорят об отказе', async () => {
    mockFlagWriteFails = true;
    const loadData = jest.fn(async () => undefined);
    pinAndReload(loadData);
    await settle();
    expect(loadData).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledWith('Не удалось закрепить');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: на целой базе перечитывают и молчат', async () => {
    const loadData = jest.fn(async () => undefined);
    pinAndReload(loadData);
    await settle();
    expect(mockWrites).toHaveLength(1);
    expect(loadData).toHaveBeenCalledTimes(1);
    expect(mockShowError).not.toHaveBeenCalled();
  });
});

describe('цена дефекта: пачка «архивировать прочитанные»', () => {
  const PEERS = ['a', 'b', 'c', 'd'];

  /** Точно тот же состав, что под долгим нажатием в шапке списка. */
  const archiveRead = (loadData: () => Promise<void>): void =>
    runGuardedOp(
      async () => {
        const res = await Promise.allSettled(PEERS.map((p) => setConversationArchived(p, 1, true)));
        await loadData();
        const failed = res.filter((r) => r.status === 'rejected').length;
        if (failed > 0) throw new Error(`Не удалось архивировать: ${failed} из ${PEERS.length}`);
      },
      'Не удалось архивировать прочитанные',
      'chat_list_archive_read_failed',
    );

  it('одна упавшая запись не отменяет остальные и не отменяет перечитывание', async () => {
    mockFlagWriteFails = true;
    mockFailAfter = 2; // две лягут, две откажут
    const loadData = jest.fn(async () => undefined);
    archiveRead(loadData);
    await settle();
    expect(mockWrites).toHaveLength(2);
    expect(loadData).toHaveBeenCalledTimes(1);
  });

  it('сколько не легло — говорят числом, а не «что-то пошло не так»', async () => {
    mockFlagWriteFails = true;
    mockFailAfter = 2;
    archiveRead(async () => undefined);
    await settle();
    expect(mockShowError).toHaveBeenCalledWith('Не удалось архивировать: 2 из 4');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: все легли — ни слова об ошибке', async () => {
    const loadData = jest.fn(async () => undefined);
    archiveRead(loadData);
    await settle();
    expect(mockWrites).toHaveLength(4);
    expect(loadData).toHaveBeenCalledTimes(1);
    expect(mockShowError).not.toHaveBeenCalled();
  });
});

const read = (...p: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...p), 'utf8');
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
  it('русское сообщение об отказе доходит до человека целиком', () => {
    // На этом держится счёт «2 из 4»: запасной текст его бы затёр.
    expect(userErrorText(new Error('Не удалось архивировать: 2 из 4'), 'запасное')).toBe(
      'Не удалось архивировать: 2 из 4',
    );
    expect(userErrorText(new Error('SQLITE_BUSY'), 'запасное')).toBe('запасное');
  });

  it('зеркалу в dmPinSync есть на что опереться: список пишется раньше', () => {
    const sync = codeOnly(read('core', 'social', 'dmPinSync.ts'));
    const kv = sync.indexOf('scopedKvSetCheckedFor(ownerProfileId, pinListKey(peerPubB64), JSON.stringify(nextIds))');
    const mirror = sync.indexOf('setConversationPinnedMessage(peerPubB64, ownerProfileId, entries[0]?.id ?? null)');
    expect(kv).toBeGreaterThan(0);
    expect(mirror).toBeGreaterThan(kv);
  });

  it('черновик пишется сам, без нажатия — потому и молчит', () => {
    const chat = codeOnly(read('ui', 'screens', 'ChatScreen.tsx'));
    expect(chat).toContain('const writeDraft = useCallback((next: string | null) => {');
    expect(chat).toContain('if (!decideDraftWrite(');
    // Точка записи одна: молчание не размазано по экрану.
    expect((chat.match(/setConversationDraft\(/g) ?? []).length).toBe(1);
  });
});

describe('форма исходников', () => {
  const LOCAL = codeOnly(read('core', 'storage', 'local.ts'));
  const LIST = codeOnly(read('ui', 'screens', 'ChatListScreen.tsx'));

  it('все пять писателей признаются в отказе', () => {
    for (const tag of [
      'conversation_draft_failed',
      'conversation_pin_failed',
      'conversation_archive_failed',
      'conversation_pin_msg_failed',
      'conversation_color_tag_failed',
    ]) {
      const at = LOCAL.indexOf(`log.warn('${tag}'`);
      expect(at).toBeGreaterThan(0);
      // `throw e` идёт сразу за журнальной строкой, а не где-то поодаль.
      expect(LOCAL.slice(at, at + 200)).toContain('throw e;');
    }
  });

  it('чужая метка отклоняется броском, а не возвратом', () => {
    const at = LOCAL.indexOf("log.warn('conversation_color_tag_rejected'");
    expect(at).toBeGreaterThan(0);
    const tail = LOCAL.slice(at, at + 160);
    expect(tail).toContain('throw new Error(');
    expect(tail).not.toContain('return;');
  });

  it('в списке переписок не осталось необработанных обещаний по флагам', () => {
    for (const bad of [
      'void setConversationPinned(',
      'void setConversationArchived(',
      'void setConversationColorTag(',
      'void Promise.all(readConvs',
    ]) {
      expect(LIST).not.toContain(bad);
    }
  });

  it('семь нажатий закрыты и у каждого своя метка для журнала', () => {
    const tags = [
      'chat_list_swipe_archive_failed',
      'chat_list_swipe_pin_failed',
      'chat_list_menu_pin_failed',
      'chat_list_menu_archive_failed',
      'chat_list_color_tag_failed',
      'chat_list_color_tag_clear_failed',
      'chat_list_archive_read_failed',
    ];
    for (const tag of tags) expect(LIST).toContain(`'${tag}'`);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('пачка считает отказавшие через allSettled', () => {
    const at = LIST.indexOf('await Promise.allSettled(');
    expect(at).toBeGreaterThan(0);
    const body = LIST.slice(at, at + 500);
    expect(body).toContain("res.filter((r) => r.status === 'rejected').length");
    // Перечитывание — до броска: остальные уже архивны, список должен сойтись.
    expect(body.indexOf('await loadData();')).toBeLessThan(body.indexOf('if (failed > 0)'));
  });

  it('оба осознанных молчания названы вслух', () => {
    const sync = codeOnly(read('core', 'social', 'dmPinSync.ts'));
    expect(sync).toContain("log.warn('dm_pin_mirror_write_failed'");
    expect(sync).toContain("log.warn('dm_pin_mirror_clear_failed'");
    const chat = codeOnly(read('ui', 'screens', 'ChatScreen.tsx'));
    expect(chat).toContain("log.warn('chat_draft_write_failed'");
  });
});
