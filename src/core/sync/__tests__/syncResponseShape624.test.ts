/**
 * Ответ сервера синхронизации: форма и объём (v4.32.624).
 *
 * Три дыры одного класса — «серверу верят на слово»:
 *
 * 1. `pulled.mutations` перебирали, не спросив, массив ли это. Форму курсора
 *    рядом проверяли, а форму самого пакета — нет.
 * 2. `acceptedMutationIds` / `rejectedMutationIds` меряли и перебирали так же.
 * 3. Тело ответа разбирал `response.json()` без потолка: границей был только
 *    дедлайн в 15 секунд.
 *
 * Проверяется форма исходника: оба модуля тянут за собой SQLite, SecureStore и
 * expo-constants, а нужное здесь видно прямо в теле функций. Положительные
 * контроли ниже требуют, чтобы соседние проверки того же места остались на
 * месте — иначе «прошло» значило бы только то, что функцию вырезали.
 */
import fs from 'fs';
import path from 'path';

const ACCOUNT_SYNC = fs.readFileSync(path.join(__dirname, '..', 'accountSync.ts'), 'utf8');
const SYNC_API = fs.readFileSync(path.join(__dirname, '..', 'syncApi.ts'), 'utf8');

/** Строки кода без комментариев: иначе цитата старого кода в комментарии сама себя и подтвердит. */
function codeLines(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const ACCOUNT_CODE = codeLines(ACCOUNT_SYNC);
const API_CODE = codeLines(SYNC_API);

describe('пакет приёма', () => {
  it('перебору предшествует проверка, что это массив', () => {
    const check = ACCOUNT_CODE.indexOf('if (!Array.isArray(pulled.mutations)) {');
    const loop = ACCOUNT_CODE.indexOf('for (const mutation of pulled.mutations) {');
    expect(check).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(check);
    expect(ACCOUNT_CODE).toContain("log.warn('sync_pull_shape_invalid', { got: typeof pulled.mutations });");
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: курсор по-прежнему отвергают до проекции', () => {
    const cursor = ACCOUNT_CODE.indexOf('if (!validSyncCursor(pulled.nextCursor)) {');
    const loop = ACCOUNT_CODE.indexOf('for (const mutation of pulled.mutations) {');
    expect(cursor).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(cursor);
    expect(ACCOUNT_CODE).toContain('if (!isDeliverable(mutation, options.ownerProfileId)) {');
  });
});

describe('ответ на отправку', () => {
  it('оба списка проверяются на форму до того, как по ним что-то решают', () => {
    const push = ACCOUNT_CODE.indexOf('pushed = await pushSyncMutations(');
    const check = ACCOUNT_CODE.indexOf(
      'if (!Array.isArray(pushed.acceptedMutationIds) || !Array.isArray(pushed.rejectedMutationIds)) {'
    );
    const reset = ACCOUNT_CODE.indexOf('if (await detectServerReset(options, state.serverEpoch, pushed.serverEpoch)) {');
    const notify = ACCOUNT_CODE.indexOf('await options.onPushAccepted(pushed, options.pendingMutations);');
    expect(push).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(push);
    expect(reset).toBeGreaterThan(check);
    expect(notify).toBeGreaterThan(check);
    expect(ACCOUNT_CODE).toContain("log.warn('sync_push_shape_invalid', {");
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: состояние по-прежнему сохраняют после проверки сброса сервера', () => {
    const reset = ACCOUNT_CODE.indexOf('if (await detectServerReset(options, state.serverEpoch, pushed.serverEpoch)) {');
    const save = ACCOUNT_CODE.indexOf('await saveSyncState(options.ownerProfileId, {\n      serverEpoch: pushed.serverEpoch,');
    expect(reset).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(reset);
  });
});

describe('объём ответа', () => {
  it('объявленную длину смотрят до разбора обоих тел', () => {
    const declared = API_CODE.indexOf(
      "const declared = parseInt(response.headers?.get?.('content-length') ?? '', 10);"
    );
    const guard = API_CODE.indexOf('if (Number.isFinite(declared) && declared > MAX_SYNC_RESPONSE_BYTES) {');
    const errBody = API_CODE.indexOf('const body = await response.json() as { error?: unknown };');
    const okBody = API_CODE.indexOf('return (await response.json()) as T;');
    expect(declared).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(declared);
    expect(errBody).toBeGreaterThan(guard);
    expect(okBody).toBeGreaterThan(guard);
    expect(API_CODE).toContain("throw responseError(response.status, 'too_large');");
  });

  it('потолок покрывает честный максимум пакета с запасом', () => {
    const m = /const MAX_SYNC_RESPONSE_BYTES = ([\d *_]+);/.exec(API_CODE);
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-eval
    const limit = eval(String(m?.[1]).replace(/_/g, '')) as number;
    // Сто записей по 420 КиБ, раздутые base64 — примерно 57 МиБ на проход.
    const honestMax = 100 * 420 * 1024 * (4 / 3);
    expect(limit).toBeGreaterThan(honestMax);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: дедлайн и разбор нечитаемого тела остались на месте', () => {
    expect(API_CODE).toContain('const timeout = setTimeout(() => controller?.abort(), SYNC_REQUEST_TIMEOUT_MS);');
    expect(API_CODE).toContain("throw responseError(response.status, 'bad_json');");
    expect(API_CODE).toContain('clearTimeout(timeout);');
  });
});
