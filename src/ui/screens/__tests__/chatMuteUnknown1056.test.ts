/**
 * Непрочитанная строка разговора запирала переписку в тишине (v4.32.1056).
 *
 * ДЕФЕКТ. Восстановление черновика и беззвучного режима читает строку
 * различающим `listConversationsRead` с v4.32.650, но пользовался третьим
 * исходом только черновик: на `null` метод выходил, оставив `isMuted` в
 * начальном `false`. Повторить чтение было некому — эффект висит на смене
 * собеседника и профиля, и до выхода из переписки больше не срабатывает.
 *
 * ЦЕНА. Тишину включает не эта строка: уведомления глушит отдельная запись
 * (`muteStore`, `muteSet`/`muteUnset`), и она продолжала работать. А снять её
 * из переписки было нечем — кнопка «Включить звук» показывается только при
 * `isMuted`, то есть ровно тогда, когда строка прочиталась. Человек видел
 * «Беззвучно…», как у неглушёной переписки, нажимал и выбирал длительность —
 * и заглушал заново то, что и так молчало. Значок колокольчика в шапке при
 * этом тоже не показывался.
 *
 * ПРАВКА. Чтение повторяется трижды с растущей паузой — отказ здесь это
 * занятая при открытии база, и он проходит сам. Пока не прочитали, экран
 * держит `convRowUnknown`: подпись пункта честная, а в выборе длительности
 * появляется «Включить звук», чтобы выйти из тишины можно было и не дожидаясь
 * удачного чтения. Отказ заодно попадает в журнал.
 *
 * ГРАНИЦЫ. Прочитанная строка работает как раньше, обеими ветками; лишний
 * пункт показывается только при непрочитанной. Черновик по-прежнему не
 * записывается на непрочитанной строке (v4.32.650) — правка добавила ему
 * попыток, но не сняла защиту.
 *
 * Поведение проверяется по форме исходников: поднять здесь настоящий экран
 * нечем (react-test-renderer в проекте нет) — тот же приём, что в
 * chatDisappearUnreadable1047.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const CHAT = () => read('ui', 'screens', 'ChatScreen.tsx');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const LOAD = () =>
  slice(CHAT(), '// Load and restore draft + mute state when opening chat', '// Load chat wallpaper');

const MUTE_MENU = () => slice(CHAT(), 'const muteLabel = isMuted', 'const autoTranslateLabel');

const MUTE_PRESS = () => slice(CHAT(), "text: muteLabel,", 'text: disappearLabel,');

describe('непрочитанная строка не выдаётся за «звук включён»', () => {
  it('экран заводит отдельное состояние, а не выводит его из isMuted', () => {
    expect(CHAT()).toContain('const [convRowUnknown, setConvRowUnknown] = useState(false);');
  });

  it('отказ чтения помечается, а удачное чтение пометку снимает', () => {
    const body = LOAD();
    expect(body).toContain('setConvRowUnknown(true);');
    expect(body).toContain('setConvRowUnknown(false);');
  });

  it('чтение повторяется, а не сдаётся с первого раза', () => {
    const body = LOAD();
    expect(body).toContain('for (const pause of [0, 1_000, 4_000])');
    expect(body).toContain('continue;');
  });

  it('повтор не переживает уход с экрана', () => {
    const body = LOAD();
    expect(body).toContain('let alive = true;');
    expect(body).toContain('if (!alive) return;');
    expect(body).toContain('return () => { alive = false; };');
  });

  it('насовсем непрочитанное попадает в журнал, а не молчит', () => {
    expect(LOAD()).toContain("log.warn('chat_conv_row_unread'");
  });
});

describe('что человек видит и чем может ответить', () => {
  it('подпись пункта называет причину', () => {
    const body = MUTE_MENU();
    expect(body).toContain('convRowUnknown');
    expect(body).toContain("'Беззвучно… (настройка не прочиталась)'");
  });

  it('выйти из тишины можно и не дождавшись чтения', () => {
    const body = MUTE_PRESS();
    expect(body).toContain('convRowUnknown');
    expect(body).toContain("{ text: 'Включить звук', onPress: () => void unmute() }");
  });

  it('снятие тишины — одно и то же действие в обоих местах', () => {
    const body = MUTE_PRESS();
    expect(body).toContain('const unmute = async (): Promise<void> => {');
    expect(body).toContain('void unmute();');
    // Обе записи проверяются, и отказ любой из них виден человеку.
    expect(body).toContain("if (!okRow || !okMute) { showError('Не удалось включить звук'); return; }");
  });
});

describe('ГРАНИЦА: прочитанная строка работает как раньше', () => {
  it('обе прежние подписи на месте', () => {
    const body = MUTE_MENU();
    expect(body).toContain("'Включить звук'");
    expect(body).toContain("'Беззвучно…'");
    expect(body).toContain('Снять без звука');
  });

  it('лишний пункт не показывается прочитанной строке', () => {
    expect(MUTE_PRESS()).toContain('...(convRowUnknown');
  });

  it('состояние беззвучия по-прежнему берётся из прочитанной строки', () => {
    const body = LOAD();
    expect(body).toContain('setIsMuted(conv.muted);');
    expect(body).toContain('setMutedUntil(conv.mutedUntil ?? null);');
  });

  it('защита черновика от непрочитанной строки не снята', () => {
    expect(LOAD()).toContain('draftRowUnknownRef.current = true;');
    expect(CHAT()).toContain('decideDraftWrite(next, draftUnreadableRef.current, draftRowUnknownRef.current)');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: тишину держит отдельная запись, не строка разговора', () => {
    const body = MUTE_PRESS();
    expect(body).toContain("muteUnset('chat', peerB64)");
    expect(body).toContain("muteSet('chat', peerB64");
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: «Включить звук» по-прежнему висит на isMuted', () => {
    // Без этого пункт был бы доступен всегда, и правка не понадобилась бы.
    expect(MUTE_MENU()).toContain('const muteLabel = isMuted');
  });

  it('срезы вырезают место, а не весь файл', () => {
    const whole = CHAT().length;
    for (const body of [LOAD(), MUTE_MENU(), MUTE_PRESS()]) {
      expect(body.length).toBeGreaterThan(80);
      expect(body.length).toBeLessThan(whole / 4);
    }
    expect(MUTE_MENU()).not.toContain('Alert.alert');
  });
});
