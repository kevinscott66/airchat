/**
 * Экраны говорят, почему имя профиля не сменилось (v4.32.743).
 *
 * Причин четыре, и человеку они велят разное: пустое поле — дозаполнить,
 * занятое имя — поменять, отказ записи — нажать «Сохранить» ещё раз тем же
 * самым именем. До этой версии `renameProfile` отвечала одним `boolean`, и:
 *
 *  - список профилей на все отказы говорил «Имя пустое или уже занято другим
 *    профилем» — то есть на отказе диска отправлял придумывать новое имя;
 *  - окно правки профиля ответ вовсе выбрасывало: писало новое имя в базу,
 *    переименование могло не состояться, и человеку говорилось «Профиль
 *    сохранён». Контактам уезжало новое имя, под таб-баром оставалось
 *    прежнее, объяснения не было никакого;
 *  - регистрация молчала совсем: строка в списке аккаунтов оставалась
 *    «Личный», и причины не оставалось даже в журнале.
 *
 * Фразы проверяются поведением (`profileRenameErrorText`), порядок записей и
 * места вызова — формой исходника: общего стыка у трёх разных экранов нет.
 */
import fs from 'fs';
import path from 'path';
import { profileRenameErrorText } from '../components/modals/profile/ownProfileEditModel';

const UI = path.join(__dirname, '..');
/** Файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (full: string): string =>
  fs
    .readFileSync(full, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
const ui = (rel: string): string => bare(path.join(UI, rel));

describe('у каждой причины отказа своя фраза', () => {
  it('на каждую из четырёх причин находятся слова', () => {
    for (const reason of ['empty', 'name_taken', 'not_found'] as const) {
      expect(profileRenameErrorText({ renamed: false, reason }).length).toBeGreaterThan(10);
    }
    expect(
      profileRenameErrorText({ renamed: false, reason: 'save_failed', err: 'busy' }).length
    ).toBeGreaterThan(10);
  });

  it('четыре причины — четыре разные фразы', () => {
    const said = new Set([
      profileRenameErrorText({ renamed: false, reason: 'empty' }),
      profileRenameErrorText({ renamed: false, reason: 'name_taken' }),
      profileRenameErrorText({ renamed: false, reason: 'not_found' }),
      profileRenameErrorText({ renamed: false, reason: 'save_failed', err: 'busy' }),
    ]);
    expect(said.size).toBe(4);
  });

  it('отказ записи зовёт повторить, а не придумывать новое имя', () => {
    const text = profileRenameErrorText({ renamed: false, reason: 'save_failed', err: 'busy' });
    expect(text).toContain('ещё раз');
    expect(text).not.toContain('занят');
  });

  it('занятое имя названо занятым — и сказано, что соседним профилем', () => {
    const text = profileRenameErrorText({ renamed: false, reason: 'name_taken' });
    expect(text).toContain('занято другим профилем');
  });

  it('причина отказа диска наружу не пересказывается', () => {
    // `err` — для журнала: «SecureStore keystore busy» человеку не говорит
    // ничего, а испугать может.
    const text = profileRenameErrorText({
      renamed: false,
      reason: 'save_failed',
      err: 'keystore busy',
    });
    expect(text).not.toContain('keystore');
  });
});

describe('правка профиля: имя в базе и строка профиля не расходятся', () => {
  const s = (): string => ui('components/modals/profile/ProfileEditModal.tsx');

  it('строка профиля переименовывается ДО записи имени в базу', () => {
    // Иначе отказ по занятому имени приходит уже поверх записанной базы:
    // отменить её нечем, а сказанное «не вышло» будет неправдой наполовину.
    const renamed = s().indexOf('const renamed = await profileManager.renameProfile(ap.id, name);');
    const put = s().indexOf('if (!(await put(OWN_DISPLAY_NAME_KEY, name))) {');
    expect(renamed).toBeGreaterThan(0);
    expect(put).toBeGreaterThan(renamed);
  });

  it('отказ переименования останавливает сохранение и назван вслух', () => {
    const at = s().indexOf('const renamed = await profileManager.renameProfile(ap.id, name);');
    const tail = s().slice(at, at + 300);
    const said = tail.indexOf('showError(profileRenameErrorText(renamed));');
    expect(said).toBeGreaterThan(0);
    expect(tail.indexOf('return;', said)).toBeGreaterThan(said);
  });

  it('отказ базы откатывает строку профиля обратно', () => {
    const put = s().indexOf('if (!(await put(OWN_DISPLAY_NAME_KEY, name))) {');
    const tail = s().slice(put, put + 500);
    expect(tail).toContain('await profileManager.renameProfile(ap.id, previousRowName)');
  });

  it('«Профиль сохранён» стоит после обеих проверок', () => {
    const renamed = s().indexOf('const renamed = await profileManager.renameProfile(ap.id, name);');
    const put = s().indexOf('if (!(await put(OWN_DISPLAY_NAME_KEY, name))) {');
    const ok = s().indexOf("showSuccess('Профиль сохранён')");
    expect(ok).toBeGreaterThan(put);
    expect(ok).toBeGreaterThan(renamed);
  });

  it('ответ переименования нигде не выбрасывается: обоих вызовов кто-то ждёт', () => {
    const calls = s().split('profileManager.renameProfile(').length - 1;
    // Их ровно два: само переименование и откат. Оба присвоены — брошенного
    // вызова, каким он был до этой версии, в файле не осталось.
    expect(calls).toBe(2);
    expect(s()).not.toMatch(/^\s*(await )?profileManager\.renameProfile\(/m);
    expect(s()).not.toMatch(/\bif \(ap\) await profileManager\.renameProfile\(/);
  });
});

describe('список профилей и регистрация', () => {
  it('список профилей берёт фразу по причине', () => {
    const s = ui('components/ProfileSelector.tsx');
    expect(s).toContain('const res = await profileManager.renameProfile(renameId, renameText);');
    expect(s).toContain('showError(profileRenameErrorText(res));');
    // Прежней фразы «на все случаи» не осталось.
    expect(s).not.toContain('Имя пустое или уже занято другим профилем');
  });

  it('регистрация: отказ доходит хотя бы до журнала', () => {
    const s = ui('screens/LoginScreen.tsx');
    const at = s.indexOf('const renamed = await profileManager.renameProfile(active.id, uname);');
    expect(at).toBeGreaterThan(0);
    const tail = s.slice(at, at + 200);
    expect(tail).toContain("log.warn('login_profile_rename_refused', { reason: renamed.reason });");
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: успешные исходы на обоих экранах целы', () => {
    expect(ui('components/ProfileSelector.tsx')).toContain("showSuccess('Имя обновлено');");
    expect(ui('screens/LoginScreen.tsx')).toContain('onDone(uname, id);');
  });
});
