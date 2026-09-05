/**
 * Куда разошлись четыре карточки быстрого доступа.
 *
 * В профиле стояла сетка 2×2: «Мой QR-код», «Секретные слова», «Звонки»,
 * «Контакты». Она собирала вместе вещи, у которых нет ничего общего, кроме
 * размера плитки, и каждая из них была не на своём месте:
 *
 *   — QR-код открывает ровно то же, что и «скопировать адрес», но стоял
 *     отдельной карточкой ниже, и связь приходилось угадывать;
 *   — «Секретные слова» были ВТОРОЙ дверью к той же фразе, что и
 *     «Ещё → Резервная копия»; две двери к ключу от аккаунта — это две
 *     проверки пароля, которые надо держать одинаковыми, и рано или поздно
 *     они разойдутся;
 *   — «Звонки» — редкая справка, а не быстрое действие;
 *   — «Контакты» — такой же раздел профиля, как «Стена» и «Избранное», и
 *     место им в той же горизонтальной полосе.
 *
 * Тест закрепляет, где эти двери стоят теперь, и — главное — что каждая из
 * них одна. Прежний файл провалил бы здесь всё, кроме проверки полосы.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');
const profile = readFileSync(join(SRC, 'ui', 'screens', 'ProfileScreen.tsx'), 'utf8');
const settings = readFileSync(join(SRC, 'ui', 'screens', 'SettingsScreen.tsx'), 'utf8');

/** Сколько раз встречается подстрока. */
function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe('сетка быстрого доступа разобрана', () => {
  it('в профиле не осталось ни сетки, ни её плиток', () => {
    expect(profile).not.toContain('actionsGrid');
    expect(profile).not.toContain('actionCard');
    expect(profile).not.toContain('actionTitle');
  });
});

describe('QR-код — рядом с адресом', () => {
  const row = profile.slice(
    profile.indexOf('<View style={styles.userIdRow}>'),
    profile.indexOf('<Text style={styles.userIdHint}>'),
  );

  it('строка адреса существует и держит обе двери', () => {
    expect(row).not.toBe('');
    expect(row).toContain('testID="user_did"');
    expect(row).toContain('testID="btn_my_qr"');
  });

  it('QR открывается только отсюда', () => {
    expect(count(profile, 'setShowQrModal(true)')).toBe(1);
    expect(row).toContain('setShowQrModal(true)');
  });

  it('подпись под строкой честно называет оба способа', () => {
    const hint = profile.slice(profile.indexOf('<Text style={styles.userIdHint}>'));
    expect(hint.slice(0, hint.indexOf('</Text>'))).toContain('QR-код');
  });

  it('окно с кодом на месте — иначе кнопка вела бы в пустоту', () => {
    expect(profile).toContain('Друг может отсканировать код');
  });
});

describe('секретные слова — одна дверь, и она в «Ещё»', () => {
  it('профиль больше не показывает слова', () => {
    expect(profile).not.toContain('getStoredMnemonic');
    expect(profile).not.toContain('seed_password_modal');
    expect(profile).not.toContain('btn_backup_seed');
    expect(profile).not.toContain('unlockSensitiveAccess');
  });

  it('профиль всё же предупреждает, если слов на устройстве нет', () => {
    expect(profile).toContain('hasStoredMnemonic');
    expect(profile).toContain('Секретные слова на этом устройстве не найдены');
  });

  it('дверь в настройках названа так же, как о ней говорит приложение', () => {
    expect(settings).toContain('Показать секретные слова');
    expect(settings).not.toContain('Показать seed-фразу');
  });

  it('раздел с дверью виден из общего списка, не открывая его', () => {
    expect(settings).toContain('badge="Секретные слова и копия истории"');
  });
});

describe('контакты — плашка в полосе разделов', () => {
  const strip = profile.slice(
    profile.indexOf('contentContainerStyle={styles.strip}'),
    profile.indexOf('</ScrollView>', profile.indexOf('contentContainerStyle={styles.strip}')),
  );

  it('стоят в той же полосе, что «Стена» и «Избранное»', () => {
    expect(strip).toContain("id: 'contacts'");
    expect(strip).toContain('setContactsVisible(true)');
  });

  it('архив по-прежнему последний', () => {
    expect(strip.indexOf("id: 'contacts'")).toBeLessThan(strip.indexOf("id: 'archive'"));
  });

  it('дверь в контакты одна', () => {
    expect(count(profile, 'setContactsVisible(true)')).toBe(1);
  });
});

describe('звонки — строка в списке разделов', () => {
  it('лежат в «Ещё», рядом с настройками приложения', () => {
    const more = profile.slice(profile.indexOf('<Text style={styles.sectionTitle}>Ещё</Text>'));
    expect(more).toContain('testID="btn_call_log"');
    expect(more.indexOf('testID="btn_call_log"')).toBeLessThan(more.indexOf('Настройки приложения'));
  });

  it('журнал открывается только отсюда', () => {
    expect(count(profile, 'setCallLogVisible(true)')).toBe(1);
  });
});
