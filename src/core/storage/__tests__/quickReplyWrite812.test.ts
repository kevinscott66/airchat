/**
 * Шаблоны быстрых ответов перестали молчать об отказе базы (v4.32.812).
 *
 * Дефект. `addQuickReply`, `updateQuickReply` и `deleteQuickReply` отдавали
 * `void`, гася исключение в `log.warn`. Экран настроек считал разрешившийся
 * промис успехом: добавление чистило поле ввода, правка закрывала окно,
 * удаление перечитывало список. Рядом жил тот же недосмотр в избранном:
 * `ProfileScreen` снимал звезду через `.then(...)` без `.catch`, а обе записи
 * (`setMessageStarred`, `setGroupMessageStarred`) бросают.
 *
 * Цена. Шаблон уходит в поле сообщения одним нажатием и перед отправкой не
 * перечитывается. Поэтому опаснее всего неудавшаяся правка: человек исправил
 * в шаблоне адрес, номер или сумму, окно закрылось — и в следующий раз одним
 * нажатием уходит прежний текст, тот самый, который он только что признал
 * неверным. Неудавшееся добавление уносит набранный текст из поля и не
 * оставляет шаблона. Неудавшееся удаление оставляет в списке ровно то, от
 * чего избавлялись, а список этот открыт в каждом чате. В избранном отказ
 * уходил в необработанный промис: строка оставалась на месте без единого
 * слова о причине.
 *
 * Правка. Все три записи возвращают `boolean`; правка вдобавок отвечает
 * `false` на ноль изменённых строк — окно открыто над тем, чего в базе уже
 * нет. Экран закрывает окно и чистит поле только после удачи и в каждом из
 * трёх случаев говорит, что именно не сложилось. У снятия звезды появился
 * `.catch` с тем же сообщением, что у очистки журнала звонков рядом.
 */
let mockFail = false;
/** Сколько строк «изменил» UPDATE — ноль значит «такого шаблона нет». */
let mockChanges = 1;
const mockRun: string[] = [];
/** Что легло в столбец текста: шаблон хранится зашифрованным ключом данных. */
const mockEncrypted: string[] = [];

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async (sql: string, params: unknown[]) => {
      if (mockFail) throw new Error('database is locked');
      mockRun.push(sql);
      for (const v of params) if (typeof v === 'string' && v.startsWith('enc2:')) mockEncrypted.push(v);
      return { changes: mockChanges, lastInsertRowId: 1 };
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

// uuid в тестовой среде упирается в отсутствующий crypto.getRandomValues —
// к делу это отношения не имеет, а без подмены добавление падало бы всегда.
jest.mock('uuid', () => ({ v4: () => 'qr-новый' }));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  AT_REST_COLUMNS: [],
  getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
  encryptAtRestString: jest.fn((v: string) => `enc2:${v}`),
  encryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : `enc2:${v}`)),
  decryptAtRestString: jest.fn((v: string) => v.replace('enc2:', '')),
  decryptAtRestNullable: jest.fn((v: string | null) => (v == null ? null : v.replace('enc2:', ''))),
  isAtRestCiphertext: jest.fn((v: unknown) => typeof v === 'string' && v.startsWith('enc2:')),
  resetDataEncryptionKeyCache: jest.fn(),
}));

import fs from 'fs';
import path from 'path';

import { addQuickReply, deleteQuickReply, updateQuickReply } from '../local';

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

beforeEach(() => {
  mockFail = false;
  mockChanges = 1;
  mockRun.length = 0;
  mockEncrypted.length = 0;
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: при исправной базе всё пишется', () => {
  // Здесь намеренно не проверяется ответ: блок обязан проходить и до правки —
  // иначе он не отличает сломанную обвязку от настоящей находки.
  it('шаблон добавляется', async () => {
    await addQuickReply(1, 'Буду через 10 минут');
    expect(mockRun.some((s) => /INSERT INTO quick_replies/.test(s))).toBe(true);
  });

  it('шаблон правится', async () => {
    await updateQuickReply('qr-1', 'Буду через 20 минут');
    expect(mockRun.some((s) => /UPDATE quick_replies/.test(s))).toBe(true);
  });

  it('шаблон удаляется', async () => {
    await deleteQuickReply('qr-1');
    expect(mockRun.some((s) => /DELETE FROM quick_replies/.test(s))).toBe(true);
  });

  it('текст шаблона ложится зашифрованным, а не как есть', async () => {
    await addQuickReply(1, 'Буду через 10 минут');
    await updateQuickReply('qr-1', 'Буду через 20 минут');
    expect(mockEncrypted).toEqual(['enc2:Буду через 10 минут', 'enc2:Буду через 20 минут']);
  });
});

describe('удачная запись отвечает утвердительно', () => {
  it('и добавление, и правка, и удаление', async () => {
    await expect(addQuickReply(1, 'Буду через 10 минут')).resolves.toBe(true);
    await expect(updateQuickReply('qr-1', 'Буду через 20 минут')).resolves.toBe(true);
    await expect(deleteQuickReply('qr-1')).resolves.toBe(true);
  });
});

describe('отказ базы доходит до вызывающего', () => {
  it('добавление отвечает false, а не молчанием', async () => {
    mockFail = true;
    await expect(addQuickReply(1, 'Буду через 10 минут')).resolves.toBe(false);
  });

  it('правка отвечает false — иначе уйдёт прежний текст', async () => {
    mockFail = true;
    await expect(updateQuickReply('qr-1', 'новый адрес')).resolves.toBe(false);
  });

  it('удаление отвечает false', async () => {
    mockFail = true;
    await expect(deleteQuickReply('qr-1')).resolves.toBe(false);
  });

  it('правка несуществующего шаблона — тоже не успех', async () => {
    // Ноль изменённых строк: окно правки открыто над тем, чего в базе уже
    // нет, и «сохранено» здесь такая же неправда, как при запертой базе.
    mockChanges = 0;
    await expect(updateQuickReply('qr-ушёл', 'новый адрес')).resolves.toBe(false);
  });
});

describe('экран настроек отвечает за каждый из трёх случаев', () => {
  const SETTINGS = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));

  it('поле ввода чистится только после удачной записи', () => {
    expect(SETTINGS).toContain('void addQuickReply(profileManager.getActiveProfile()?.id ?? 1, text).then((ok) => {');
    expect(SETTINGS).toContain(
      "if (!ok) { showError('Шаблон не сохранился: хранилище занято. Текст остался в поле — попробуйте ещё раз.'); return; }",
    );
    expect(SETTINGS).not.toContain('.then(() => { setQuickReplyInput(\'\'); loadQuickReplies(); });');
  });

  it('окно правки закрывается только после удачной записи', () => {
    expect(SETTINGS).toContain('void updateQuickReply(editingQR.id, editingQRText).then((ok) => {');
    expect(SETTINGS).toContain(
      "if (!ok) { showError('Шаблон не изменился: хранилище занято. Правка перед вами — попробуйте сохранить ещё раз.'); return; }",
    );
    expect(SETTINGS).not.toContain('.then(() => { setEditingQR(null); loadQuickReplies(); });');
  });

  it('несостоявшееся удаление названо вслух', () => {
    expect(SETTINGS).toContain('void deleteQuickReply(qr.id).then((ok) => {');
    expect(SETTINGS).toContain(
      "if (!ok) showError('Шаблон не удалился: хранилище занято. Попробуйте ещё раз.');",
    );
    expect(SETTINGS).not.toContain('void deleteQuickReply(qr.id).then(loadQuickReplies);');
  });
});

describe('избранное: снятие звезды больше не роняет отказ в пустоту', () => {
  const PROFILE = codeOnly(read('ui', 'screens', 'ProfileScreen.tsx'));

  it('у промиса есть catch с сообщением', () => {
    expect(PROFILE).toContain(
      ".catch(() => Alert.alert('Избранное', 'Не удалось убрать: хранилище занято. Попробуйте ещё раз.'));",
    );
    expect(PROFILE).not.toContain(
      'void unstar.then(() => setStarredEntries((prev) => prev.filter((e) => e.message.id !== id)));',
    );
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: обе записи звезды действительно бросают', () => {
    const local = codeOnly(read('core', 'storage', 'local.ts'));
    for (const fn of ['setMessageStarred', 'setGroupMessageStarred']) {
      const at = local.indexOf(`export async function ${fn}(`);
      expect(at).toBeGreaterThan(0);
      const body = local.slice(at, local.indexOf('\n}', at));
      expect(body).not.toContain('catch');
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: шаблон уходит нажатием, без перечитывания', () => {
  it('лист шаблонов открыт в каждом чате', () => {
    const attach = codeOnly(read('ui', 'components', 'AttachSheet.tsx'));
    expect(attach).toContain('const list = await listQuickRepliesRead(profileId);');
  });

  it('нажатие вставляет текст шаблона в поле сообщения', () => {
    const chat = codeOnly(read('ui', 'screens', 'ChatScreen.tsx'));
    expect(chat).toContain('void listQuickRepliesRead(activeProfileId).then((list) => {');
  });
});
