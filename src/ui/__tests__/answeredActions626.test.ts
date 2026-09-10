/**
 * Нажатия отвечают за свой исход (v4.32.626).
 *
 * Разбор этого круга собрал один и тот же дефект в девяти местах: обещание
 * пользователю выдавалось до того, как работа подтверждена, — или вместо неё.
 * Кнопка закрывала окно и показывала успех, а запись не проходила; промис
 * уходил под `void` без `.catch`, и отказ пропадал целиком; булев ответ
 * функции, специально сделанный проверяемым, никто не смотрел.
 *
 * Проверяется форма исходника: у всех девяти мест нет ни одного общего
 * поведенческого стыка (разные экраны, разные хранилища, разные модалки), а
 * общий у них ровно текст. Положительные контроли ниже держат каждую вырезку.
 */
import fs from 'fs';
import path from 'path';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');
/** Тот же файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
const count = (s: string, needle: string): number => s.split(needle).length - 1;

it('истории: видео в полосе показывается видео и на основном пути', () => {
  const s = bare('components/StoriesRow.tsx');
  // Дефект 626-го: редактор рисовался из двух мест, и признак «это видео»
  // ветка пустого состояния передавала, а основная — нет; .mp4 уезжал в
  // <Image>, то есть в пустой чёрный кадр.
  //
  // v4.32.691 закрыла его не вторым признаком, а тем, что признака больше
  // нет: редактор один на все три типа и тип узнаёт сам. Поэтому здесь
  // проверяется уже не совпадение двух значений, а невозможность их
  // разойтись — обе точки отрисовки передают ОДНО И ТО ЖЕ.
  expect(s).not.toContain('isVideo');
  expect(count(s, '<StoryComposerModal')).toBe(2);
  expect(count(s, 'onPublish={(draft) => void publishDraft(draft)}')).toBe(2);
  expect(count(s, 'onCancel={() => setComposerVisible(false)}')).toBe(2);
  // И тип, с которым сторис уходит в сеть, берётся у самого черновика —
  // и при рассылке, и при разборе её исхода. Разъехаться им не на чем.
  expect(s).toContain('await publishStory(pair, draft.uri, draft.text, draft.mediaType);');
  expect(s).toContain('storyPublishProblem(res, draft.mediaType)');
  // Решение «это видео» принимается ровно в одном месте — в редакторе.
  const comp = bare('components/StoryComposerModal.tsx');
  expect(count(comp, "mode === 'video' ? 'video' : 'image'")).toBe(1);
});

it('профили: отказ переименования называется вслух', () => {
  const s = bare('components/ProfileSelector.tsx');
  const at = s.indexOf('const ok = await profileManager.renameProfile(renameId, renameText);');
  expect(at).toBeGreaterThan(0);
  const tail = s.slice(at, at + 600);
  const guard = tail.indexOf("showError('Имя пустое или уже занято другим профилем');");
  const ret = tail.indexOf('return;', guard);
  const success = tail.indexOf("showSuccess('Имя обновлено');");
  expect(guard).toBeGreaterThan(0);
  expect(ret).toBeGreaterThan(guard);
  expect(success).toBeGreaterThan(ret);
});

it('настройки: флаг пароля читается fail-closed в обеих точках', () => {
  const s = bare('screens/SettingsScreen.tsx');
  // Застрявший false предлагал «Установить пароль» — а тот пишет новый,
  // ни разу не спросив старый.
  expect(count(s, '.catch(() => setHasAppPassword(true))')).toBe(2);
});

it('настройки: установка пароля перепроверяет, что его ещё нет', () => {
  const s = bare('screens/SettingsScreen.tsx');
  const at = s.indexOf('try { already = await authGuard.hasPassword(); } catch { already = true; }');
  expect(at).toBeGreaterThan(0);
  const tail = s.slice(at, at + 500);
  expect(tail).toContain('if (already) {');
  expect(tail).toContain('Пароль уже установлен');
  // Запись — только после этой двери.
  expect(tail.indexOf('await authGuard.setPassword(')).toBeGreaterThan(tail.indexOf('if (already) {'));
});

it('настройки: строка уходит из «Заглушённых» только вместе с записью', () => {
  const s = bare('screens/SettingsScreen.tsx');
  const at = s.indexOf('const ok = await unmute(entry.kind, entry.id);');
  expect(at).toBeGreaterThan(0);
  const tail = s.slice(at, at + 400);
  const guard = tail.indexOf("showError('Не удалось включить уведомления'); return;");
  expect(guard).toBeGreaterThan(0);
  expect(tail.indexOf('setMutedList(')).toBeGreaterThan(guard);
});

it('очистка истории называет отказ в обеих переписках', () => {
  for (const rel of ['screens/ChatScreen.tsx', 'screens/ChatListScreen.tsx']) {
    expect(bare(rel)).toContain("showError(userErrorText(e, 'Не удалось очистить историю'));");
  }
});

it('заметка о собеседнике удаляется проверенной формой', () => {
  const s = bare('components/modals/profile/ProfileChatBlock.tsx');
  expect(s).toContain('await m.kvDeleteScopedChecked(activeProfileId, m.contactNoteKey(peerB64));');
  const at = s.indexOf('await m.kvDeleteScopedChecked(');
  const tail = s.slice(at, at + 400);
  const fail = tail.indexOf("showError(userErrorText(e, 'Не удалось удалить заметку'));");
  expect(fail).toBeGreaterThan(0);
  // Поле очищается только после удачи, и до него — return по отказу.
  expect(tail.indexOf('return;', fail)).toBeGreaterThan(fail);
  expect(tail.indexOf("setContactNote('')")).toBeGreaterThan(fail);
  // И это именно проверенная форма, а не тихая.
  expect(s).not.toContain('m.kvDeleteScoped(');
});

it('экраны пароля не молчат на отказе хранилища', () => {
  expect(bare('screens/ForgotPasswordScreen.tsx')).toContain(
    "showError(userErrorText(e, 'Не удалось сохранить пароль'));"
  );
  const p = bare('screens/PasswordScreen.tsx');
  expect(p).toContain("showError(userErrorText(e, 'Не удалось проверить пароль'));");
  // Проверка «включён ли вход по лицу» стоит внутри try, а не перед ним.
  const at = p.indexOf('let stored: string | null = null;');
  expect(at).toBeGreaterThan(0);
  const tail = p.slice(at, at + 300);
  expect(tail.indexOf('try {')).toBeLessThan(tail.indexOf('await readBiometricPassword();'));
});

it('ПРОВЕРКА НЕ ПУСТАЯ: все девять файлов на месте и это те самые экраны', () => {
  const anchors: Array<[string, string]> = [
    ['components/StoriesRow.tsx', 'StoryComposerModal'],
    ['components/ProfileSelector.tsx', 'profileManager.renameProfile('],
    ['screens/SettingsScreen.tsx', 'authGuard.hasPassword()'],
    ['screens/ChatScreen.tsx', 'clearChatHistory(peerB64, activeProfileId)'],
    ['screens/ChatListScreen.tsx', 'clearChatHistory(item.contactPubB64, pid)'],
    ['components/modals/profile/ProfileChatBlock.tsx', 'contactNoteKey('],
    ['screens/ForgotPasswordScreen.tsx', 'resetPasswordWithVerifiedSeed('],
    ['screens/PasswordScreen.tsx', 'readBiometricPassword()'],
  ];
  for (const [rel, anchor] of anchors) {
    expect(bare(rel).includes(anchor)).toBe(true);
  }
});

it('ПРОВЕРКА НЕ ПУСТАЯ: вырезки без комментариев не пустые и правда без них', () => {
  const s = bare('screens/SettingsScreen.tsx');
  expect(s.length).toBeGreaterThan(10000);
  expect(s).not.toContain('v4.32.626:');
});
