/**
 * «Спросить хранилище не вышло» перестало значить «телефон чистый»
 * (v4.32.1072).
 *
 * ДЕФЕКТ. Эффект приветствия начинался с `await hasStoredMnemonic()`, и весь
 * он был обёрнут одним `catch`, гасившим всё подряд под подписью «fallback:
 * обычный welcome».
 * Но `hasStoredMnemonic` отказы хранилища пробрасывает намеренно:
 * `readSeedRecord` сводит к «запись есть, но не открылась» только
 * `SecureStoreUnreadableError`, а «Keystore заперт / IndexedDB недоступен»
 * бросает дальше — «это не «запись испорчена», а «сейчас не ответили»».
 * Бросок гасился, `phraseUnreadable` оставался `false`, и welcome рисовался
 * ровно как для чистой установки.
 *
 * ЦЕНА. Та же, что закрывал v4.32.651, только вошедшая в другую дверь. На
 * welcome кнопка «Создать новый аккаунт» живая; предупреждение и переспрос
 * висели на флаге, который в этом случае не поднимался. Одно нажатие —
 * `generateMnemonicAndStore` пишет новую фразу и новые ключи поверх старых,
 * и прежний аккаунт не вернуть ничем. Хранилище не отвечает как раз в первые
 * секунды после перезагрузки телефона — то есть тогда, когда приложение и
 * открывают.
 *
 * ПРАВКА. Ответов четыре: `none`, `ready`, `unreadable` и `unknown`. Чтение
 * «есть ли запись» получило свой `try`, и его бросок становится `unknown`.
 * Переспрашивают оба тревожных ответа, но разными словами: обещать «на
 * устройстве уже есть аккаунт» там, где мы этого не знаем, нельзя.
 *
 * ГРАНИЦЫ. Создание не запрещено ни в одном случае — у кого запись правда
 * испорчена и у кого хранилище правда молчит, это единственный выход.
 * Меняется только то, что он сделан осознанно.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  decideStoredPhraseState,
  phraseAskBanner,
  phraseOverwriteWarning,
} from '../../../core/backup/storedPhraseState';

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const ONB = (): string =>
  codeOnly(readFileSync(join(__dirname, '..', 'OnboardingScreen.tsx'), 'utf8'));
const SEED = (): string =>
  readFileSync(join(__dirname, '..', '..', '..', 'core', 'backup', 'seedPhrase.ts'), 'utf8');

describe('четвёртый ответ назван и разведён по словам', () => {
  it('«не знаем» переспрашивает, но не обещает, что аккаунт есть', () => {
    const w = phraseOverwriteWarning('unknown');
    expect(w).not.toBeNull();
    expect(w?.title).not.toContain('уже есть аккаунт');
    expect(w?.body).toContain('Если есть');
    expect(w?.body).toContain('навсегда');
  });

  it('«не открылась» по-прежнему говорит прямо: аккаунт есть', () => {
    const w = phraseOverwriteWarning('unreadable');
    expect(w?.title).toContain('уже есть аккаунт');
    expect(w?.body).toContain('сотрёт их навсегда');
  });

  it('о чём знаем — о том не переспрашиваем', () => {
    expect(phraseOverwriteWarning('none')).toBeNull();
    expect(phraseOverwriteWarning('ready')).toBeNull();
  });

  it('надписи на welcome — те же четыре ответа и два разных текста', () => {
    expect(phraseAskBanner('none')).toBeNull();
    expect(phraseAskBanner('ready')).toBeNull();
    const unknown = phraseAskBanner('unknown');
    const unreadable = phraseAskBanner('unreadable');
    expect(unknown).toContain('Не удалось проверить');
    expect(unreadable).toContain('уже есть аккаунт');
    expect(unknown).not.toBe(unreadable);
  });
});

describe('форма исходника экрана', () => {
  it('чтение «есть ли запись» имеет свой try, и его бросок — это «не знаем»', () => {
    const s = ONB();
    const at = s.indexOf('present = await hasStoredMnemonic();');
    expect(at).toBeGreaterThan(0);
    const tail = s.slice(at, at + 400);
    expect(tail).toContain('} catch (e) {');
    expect(tail).toContain("log.warn('onboarding_phrase_presence_unknown', { err: rawErrorText(e) });");
    expect(tail).toContain("if (!cancelled) setPhraseAsk('unknown');");
    expect(tail).toContain('return;');
  });

  it('решение кладётся в состояние целиком, без сведения к флагу', () => {
    const s = ONB();
    expect(s).toContain("const [phraseAsk, setPhraseAsk] = useState<PhraseAskState>('none');");
    expect(s).toContain('setPhraseAsk(phraseState);');
    expect(s).not.toContain('setPhraseUnreadable');
    expect(s).not.toContain('phraseUnreadable');
  });

  it('переспрос спрашивает правило, а слова берёт у него же', () => {
    const s = ONB();
    expect(s).toContain('const overwriteWarning = phraseOverwriteWarning(phraseAsk);');
    expect(s).toContain('if (overwriteWarning && !(await confirmOverwrite(overwriteWarning))) return;');
    expect(s).toContain('const confirmOverwrite = (warning: { title: string; body: string }): Promise<boolean> =>');
    expect(s).toContain('        warning.title,');
    expect(s).toContain('        warning.body,');
  });

  it('надпись на welcome тоже спрашивает правило', () => {
    const s = ONB();
    expect(s).toContain('{phraseAskBanner(phraseAsk) ? (');
    expect(s).toContain('{phraseAskBanner(phraseAsk)}');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние три ответа целы', () => {
  it('разбор «нет / не открылась / готова» не тронут', () => {
    expect(decideStoredPhraseState(false, null)).toBe('none');
    expect(decideStoredPhraseState(false, 'abandon ability')).toBe('none');
    expect(decideStoredPhraseState(true, null)).toBe('unreadable');
    expect(decideStoredPhraseState(true, '   ')).toBe('unreadable');
    expect(decideStoredPhraseState(true, 'abandon ability able')).toBe('ready');
  });

  it('отказ ЧТЕНИЯ фразы по-прежнему гасится внутри и даёт «не открылась»', () => {
    const s = ONB();
    expect(s).toContain('stored = await getStoredMnemonic();');
    expect(s).toContain('const phraseState = decideStoredPhraseState(present, stored);');
    expect(s).toContain("if (phraseState !== 'ready') return;");
  });

  it('ГРАНИЦА: создание не запрещено ни при одном ответе', () => {
    const s = ONB();
    expect(s).toContain('disabled={createNewBtn.loading}');
    expect(s).not.toContain('disabled={phraseAsk');
    expect(s).not.toContain('disabled={overwriteWarning');
    expect(s).toContain("{ text: 'Всё равно создать', style: 'destructive', onPress: () => resolve(true) },");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('hasStoredMnemonic и правда бросает, а не отвечает «нет»', () => {
    const s = SEED();
    // readSeedRecord сводит к «есть, но не открылась» только один класс
    // отказов; остальные летят наружу — и это сделано намеренно.
    expect(s).toContain('if (!isSecureStoreUnreadable(e)) throw e;');
    expect(s).toContain('const { present: encPresent } = await readSeedRecord(MNEMONIC_ENC_PAYLOAD_KEY);');
    // Кэш отказ хранилища не спасает: он сам в базе, и при её отказе путь
    // уходит на медленный.
    expect(s).toContain('} catch { /* kv unavailable → fall through to the slow path */ }');
    expect(s).toContain('const real = await hasStoredMnemonicUncached();');
  });

  it('кнопка на welcome и правда пишет поверх, необратимо', () => {
    const s = ONB();
    expect(s).toContain('const { mnemonic, pair } = await generateMnemonicAndStore();');
    expect(s).toContain('testID="btn_create_new"');
  });
});
