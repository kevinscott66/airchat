/**
 * Запись карточки профиля отвечает за свой исход (v4.32.708).
 *
 * `ownFieldSet` документирован как проверяемый: «`false` — не записалось».
 * В двух местах его ответ выбрасывался.
 *
 * Регистрация (LoginScreen): имя писалось и человека пускали дальше. Но
 * загрузка приложения проверяет факт регистрации ровно этим полем, и на
 * следующем холодном запуске, не найдя его, возвращала на экран регистрации.
 * До того момента имени не было ни под таб-баром, ни у контактов, ни в
 * группах — и ни одного слова о том, что запись не прошла.
 *
 * Правка профиля (ProfileEditModal): девять записей подряд, и ни одна не
 * смотрела на ответ. Окно закрывалось со словами «Профиль сохранён», карточка
 * уезжала контактам, юзернейм занимался в общем реестре по сети — а в базе
 * оставалось прежнее.
 *
 * Проверяется форма исходника: общего поведенческого стыка у двух экранов нет
 * (разные окна, разные пути), общее у них — выброшенный булев ответ.
 * Положительные контроли ниже держат каждую вырезку.
 */
import fs from 'fs';
import path from 'path';

const UI = path.join(__dirname, '..');
const CORE = path.join(__dirname, '..', '..', 'core');
/** Файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (full: string): string =>
  fs
    .readFileSync(full, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
const ui = (rel: string): string => bare(path.join(UI, rel));
const core = (rel: string): string => bare(path.join(CORE, rel));
const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe('отказ записи больше не выдаётся за успех', () => {
  it('регистрация: имя не записалось — на главный экран не пускают', () => {
    const s = ui('screens/LoginScreen.tsx');
    expect(s).not.toContain('await ownFieldSet(OWN_DISPLAY_NAME_KEY, uname);');
    const guard = s.indexOf('if (!(await ownFieldSet(OWN_DISPLAY_NAME_KEY, uname))) {');
    expect(guard).toBeGreaterThan(0);
    const tail = s.slice(guard, guard + 400);
    const said = tail.indexOf("showError('Не удалось сохранить имя. Попробуйте ещё раз');");
    const ret = tail.indexOf('return;', said);
    expect(said).toBeGreaterThan(0);
    expect(ret).toBeGreaterThan(said);
    // И выход на главный экран стоит ПОСЛЕ этой проверки, а не до неё.
    expect(s.indexOf('onDone(uname, id);')).toBeGreaterThan(guard);
  });

  it('правка профиля: ни одной записи мимо проверяющей обёртки', () => {
    const s = ui('components/modals/profile/ProfileEditModal.tsx');
    // Единственный вызов на весь файл — внутри самой обёртки.
    expect(count(s, 'ownFieldSet(')).toBe(1);
    const put = s.indexOf('const put = async (key: OwnProfileKey, value: string): Promise<boolean> => {');
    expect(put).toBeGreaterThan(0);
    const body = s.slice(put, put + 260);
    expect(body).toContain('const ok = await ownFieldSet(key, value);');
    expect(body).toContain('if (!ok) writeFailed = true;');
    // Все девять полей идут через неё — и ни одним больше.
    expect(s.match(/\bput\(/g)?.length).toBe(9);
  });

  it('правка профиля: отказ назван вслух и окно остаётся открытым', () => {
    const s = ui('components/modals/profile/ProfileEditModal.tsx');
    const gate = s.indexOf('if (writeFailed) {');
    expect(gate).toBeGreaterThan(0);
    const tail = s.slice(gate, gate + 300);
    const said = tail.indexOf("showError('Часть изменений не сохранилась. Попробуйте ещё раз');");
    const ret = tail.indexOf('return;', said);
    expect(said).toBeGreaterThan(0);
    expect(ret).toBeGreaterThan(said);
    // Ни «сохранено», ни закрытия окна после отказа не будет.
    expect(s.indexOf("showSuccess('Профиль сохранён')")).toBeGreaterThan(gate);
    expect(s.indexOf('onClose();\n    } catch (e) {')).toBeGreaterThan(gate);
  });

  it('правка профиля: имя в общем реестре не занимается после отказа базы', () => {
    const s = ui('components/modals/profile/ProfileEditModal.tsx');
    // Реестр — по сети и с последствиями для чужих устройств. Проверка стоит
    // ДО него, а не после.
    expect(s.indexOf('if (writeFailed) {')).toBeLessThan(s.indexOf('await saveOwnUsernameGlobally('));
    // И до рассылки карточки контактам.
    expect(s.indexOf('if (writeFailed) {')).toBeLessThan(s.indexOf('if (touchedProfile) void publish();'));
  });

  it('правка профиля: отказ на имени останавливает переименование и переиздание', () => {
    const s = ui('components/modals/profile/ProfileEditModal.tsx');
    const guard = s.indexOf('if (!(await put(OWN_DISPLAY_NAME_KEY, name))) {');
    expect(guard).toBeGreaterThan(0);
    expect(s.indexOf('await profileManager.renameProfile(ap.id, name);')).toBeGreaterThan(guard);
    const tail = s.slice(guard, guard + 300);
    expect(tail).toContain("showError('Не удалось сохранить имя. Попробуйте ещё раз');");
    expect(tail.indexOf('return;')).toBeGreaterThan(0);
    expect(tail.indexOf('return;')).toBeLessThan(tail.indexOf('await profileManager.init();'));
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы целы', () => {
  it('пустое имя по-прежнему не проходит ни на одном из двух экранов', () => {
    const login = ui('screens/LoginScreen.tsx');
    expect(login).toContain("showError('Введите имя пользователя');");
    expect(login).toContain('const uname = stripOwnDisplayName(username);');
    const modal = ui('components/modals/profile/ProfileEditModal.tsx');
    expect(modal).toContain("showError('Имя не может быть пустым');");
  });

  it('правка профиля: все девять полей всё так же пишутся', () => {
    const s = ui('components/modals/profile/ProfileEditModal.tsx');
    for (const key of [
      'OWN_DISPLAY_NAME_KEY, name',
      "'user_bio', bio",
      "'user_custom_status', status",
      "'user_pronouns', pronouns",
      "'user_website', website",
      "'user_twitter', twitter",
      "'user_github', github",
      "'user_twitter_proof'",
      "'user_github_proof'",
    ]) {
      expect(count(s, key)).toBeGreaterThan(0);
    }
  });

  it('правка профиля: спор о юзернейме по-прежнему оставляет окно открытым', () => {
    const s = ui('components/modals/profile/ProfileEditModal.tsx');
    expect(s).toContain('showError(usernameClaimErrorText(claim.reason));');
    expect(s).toContain('showError(usernameSaveErrorText(done.reason));');
    expect(count(s, 'setSaved({ ...saved, name, bio, status, pronouns, website, twitter, github });')).toBe(2);
  });

  it('правка профиля: успех и закрытие окна на месте — просто ниже проверки', () => {
    const s = ui('components/modals/profile/ProfileEditModal.tsx');
    expect(s).toContain("showSuccess('Профиль сохранён')");
    expect(s).toContain('onSaved?.(name);');
    expect(s).toContain('onClose();');
    expect(s).toContain('if (touchedProfile) void publish();');
  });

  it('регистрация: остальное поведение экрана не тронуто', () => {
    const s = ui('screens/LoginScreen.tsx');
    expect(s).toContain('await profileManager.init();');
    expect(s).toContain("log.warn('login_profile_rename_failed', {");
    expect(s).toContain("if (cid) await ownFieldSet('user_profile_cid', cid);");
    expect(s).toContain("log.error('login_init_failed', { err: msg });");
    expect(s).toContain('setBusy(false);');
  });

  it('загрузка приложения всё так же спрашивает это самое поле', () => {
    const app = bare(path.join(__dirname, '..', '..', 'App.tsx'));
    expect(app).toContain('const uname = await ownFieldGet(OWN_DISPLAY_NAME_KEY);');
    expect(app).toContain('setSavedSession(null);');
    expect(app).toContain("initialRouteName={savedSession ? 'Main' : 'Login'}");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ownFieldSet по-прежнему отвечает булевым, и `false` значит «не записалось»', () => {
    const s = core('identity/ownProfile.ts');
    expect(s).toContain('export async function ownFieldSet(key: OwnProfileKey, value: string): Promise<boolean> {');
    expect(s).toContain('export async function ownFieldSetFor(pid: number, key: OwnProfileKey, value: string): Promise<boolean> {');
    const at = s.indexOf('export async function ownFieldSetFor(');
    const body = s.slice(at, at + 500);
    expect(body).toContain('if (!(await kvSetSecretScoped(pid, key, value))) {');
    expect(body).toContain('return false;');
    expect(body).toContain('return true;');
  });

  it('тип ключа доступен снаружи — обёртке есть чем типизироваться', () => {
    const s = core('identity/ownProfile.ts');
    expect(s).toContain("export type { OwnProfileKey } from '../storage/kvKeys';");
    const modal = ui('components/modals/profile/ProfileEditModal.tsx');
    expect(modal).toContain('  type OwnProfileKey,');
  });

  it('то же место в настройках так и держит проверку с v4.32.626', () => {
    const s = ui('screens/SettingsScreen.tsx');
    expect(s).toContain("void ownFieldSet('user_custom_status', s)");
    expect(s).toContain("if (!ok) { setCustomStatus(prev); showError('Не удалось сохранить статус'); }");
  });
});
