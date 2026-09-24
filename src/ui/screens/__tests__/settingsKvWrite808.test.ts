/**
 * Настройки перестали обещать за базу (v4.32.808).
 *
 * Дефект. Пятнадцать переключателей экрана настроек писались через
 * `void kvSet(...)`. `kvSet` гасит свой отказ и возвращает `void` — то есть
 * ответа базы у вызывающего не просто не было, его неоткуда было взять.
 * Экран при этом переставляет переключатель ДО записи, чтобы тот не залипал.
 * Общее правило с откатом и сообщением на экране уже жило (v4.32.694), но
 * применялось только к шести решениям о приватности.
 *
 * Цена. Человек видит выбранное положение, за которым на диске ничего нет, и
 * узнаёт об этом при следующем запуске — если узнаёт вообще. У некоторых
 * переключателей цена прямая: «Блокировать при выходе» и задержка блокировки
 * — это защита переписки на потерянном телефоне; «Связь в фоне» решает,
 * придёт ли звонок в свёрнутое приложение; тихие часы и звук — разница между
 * будильником среди ночи и тишиной. Опасная сторона у каждого своя, но
 * общего одно: положение на экране обязано совпадать с тем, что переживёт
 * перезапуск.
 *
 * Правка. Правило переименовано в `applyPref` — оно никогда не было про
 * приватность, — и поверх него написан `applyKvPref(key, value, revert)` на
 * `kvSetChecked`. Все пятнадцать мест идут через него. Откат возвращает
 * ИМЕННО прежнее значение, а не умолчание: у авто-скачивания, задержки
 * блокировки и границ тихих часов положений больше двух. У «Связи в фоне»
 * откат снимает и саму работу, иначе фоновая связь осталась бы включённой
 * при выключенном переключателе.
 */
import fs from 'fs';
import path from 'path';

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

const SETTINGS = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
const STORE = codeOnly(read('core', 'storage', 'local.ts'));

/** Ключ → откат, который обязан стоять рядом с записью. */
const SWITCHES: Array<[string, string]> = [
  ["applyKvPref('notify_dm', String(v)", '() => setNotifyDm(!v));'],
  ["applyKvPref('notify_groups', String(v)", '() => setNotifyGroups(!v));'],
  ["applyKvPref('notify_calls', String(v)", '() => setNotifyCalls(!v));'],
  ["applyKvPref('notify_feed', String(v)", '() => setNotifyFeed(!v));'],
  ["applyKvPref('notify_mentions', String(v)", '() => setNotifyMentions(!v));'],
  ["applyKvPref('notify_preview', String(v)", '() => setNotifyPreview(!v));'],
  ["applyKvPref('notify_vibrate', String(v)", '() => setNotifyVibrate(!v));'],
  ["applyKvPref('notify_sound', String(v)", '() => setNotifySound(!v));'],
  ["applyKvPref('dnd_enabled', String(v)", '() => setDndEnabled(!v));'],
  ["applyKvPref('auto_lock_on_exit', String(v)", '() => setAutoLockEnabled(!v));'],
];

describe('отказ записи настройки доходит до экрана', () => {
  it('ни одной записи через kvSet на экране не осталось', () => {
    expect(SETTINGS).not.toContain('void kvSet(');
    expect(SETTINGS).not.toContain('kvSet(');
    // И самого имени в импортах: незанятая дверь однажды снова откроется.
    expect(SETTINGS).toContain('kvGet, kvSetChecked, clearAllMessageHistory, liveAttachmentBlobIds,');
  });

  it('правило одно на все переключатели, и оно на проверяемой записи', () => {
    expect(SETTINGS).toContain('const applyKvPref = useCallback(');
    expect(SETTINGS).toContain('void applyPref(() => kvSetChecked(key, value), revert);');
    expect(SETTINGS).toContain('(key: string, value: string, revert: () => void): void => {');
  });

  it.each(SWITCHES)('%s идёт через правило и знает свой откат', (call, revert) => {
    expect(SETTINGS).toContain(call);
    const at = SETTINGS.indexOf(call);
    expect(SETTINGS.slice(at, at + 240)).toContain(revert);
  });

  it('связь в фоне откатывает и работу, а не только вид', () => {
    // Иначе переключатель стоял бы выключенным, а фоновая связь работала бы
    // до перезапуска — и тратила батарею у человека, который её выключил.
    expect(SETTINGS).toContain(`applyKvPref(KEEPALIVE_KEY, String(v), () => {
                  setBgKeepalive(!v);
                  setBackgroundKeepaliveEnabled(!v);
                });`);
  });

  it('у настроек с тремя и более положениями откат возвращает прежнее, а не умолчание', () => {
    expect(SETTINGS).toContain(
      "const prev = autoDownload; setAutoDownload(val); applyKvPref('auto_download_media', val, () => setAutoDownload(prev));",
    );
    expect(SETTINGS).toContain(
      "const prev = autoLockDelayMs; setAutoLockDelayMs(ms); applyKvPref('auto_lock_delay_ms', String(ms), () => setAutoLockDelayMs(prev));",
    );
    expect(SETTINGS).toContain(
      "const prev = dndStart; setDndStart(dndTimeTmp); applyKvPref('dnd_start', String(dndTimeTmp), () => setDndStart(prev));",
    );
    expect(SETTINGS).toContain(
      "const prev = dndEnd; setDndEnd(dndTimeTmp); applyKvPref('dnd_end', String(dndTimeTmp), () => setDndEnd(prev));",
    );
  });

  it('все пятнадцать мест на месте — счёт, а не выборочная проверка', () => {
    expect((SETTINGS.match(/applyKvPref\(/g) ?? []).length).toBe(15);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежнее правило цело', () => {
  it('откат и сообщение остались теми же', () => {
    expect(SETTINGS).toContain('const applyPref = useCallback(');
    expect(SETTINGS).toContain('        revert();');
    expect(SETTINGS).toContain("        showError('Настройка не сохранилась. Попробуйте ещё раз.');");
  });

  it('решения о приватности по-прежнему идут своей дверью', () => {
    // applyKvPref для них не годится: они лежат в namespace профиля, а не
    // общим ключом, и часть из них после записи ещё и рассылается.
    // Восьмой — сам applyKvPref: он и есть «поверх того же правила».
    expect((SETTINGS.match(/void applyPref\(/g) ?? []).length).toBe(8);
    expect((SETTINGS.match(/void applyPref\(\(\) => privacyPrefSet/g) ?? []).length).toBe(4);
    expect(SETTINGS).toContain(').then((ok) => { if (ok) return broadcastLastSeenPref(); });');
  });

  it('чтение настроек при открытии экрана не менялось', () => {
    expect(SETTINGS).toContain("kvGet('notify_dm')");
    expect(SETTINGS).toContain("kvGet('auto_lock_on_exit')");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('kvSet действительно гасит свой отказ и не возвращает ничего', () => {
    // Отсюда и «обещание за базу»: у вызывающего нет ответа даже теоретически.
    expect(STORE).toContain('export async function kvSet(key: string, value: string): Promise<void> {');
    expect(STORE).toContain('export async function kvSetChecked(key: string, value: string): Promise<boolean> {');
  });

  it('проверяемая запись сообщает и о тесноте на диске', () => {
    // Самая частая причина отказа — не поломка базы, а место: об этом человеку
    // говорят отдельно, потому что лечится оно им, а не приложением.
    expect(STORE).toContain('notifyIfStoragePressure');
  });
});
