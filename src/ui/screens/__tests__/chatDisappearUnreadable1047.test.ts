/**
 * Непрочитанная строка разговора выдавалась за «ничего не настроено» (v4.32.1047).
 *
 * ДЕФЕКТ. Экран переписки брал метаданные разговора через `listConversations`,
 * а она сводит отказ базы к пустому списку (`local.ts`: `?? []`). Дальше
 * `convs.find(...)` не находил ничего, и `conv` был `undefined` — ровно как у
 * человека, с которым ещё не переписывались. Соседняя ветка того же экрана
 * (восстановление черновика, v4.32.650) уже спрашивала различающим чтением, а
 * эти две — нет.
 *
 * ЦЕНА. Три утверждения подряд, и все три ложные:
 *   — `setPinnedMsg(null)` — закреплённое сообщение пропадало из шапки;
 *   — `setDisappearMs(null)` — пропадал значок «⏱ Исчезают через …», а меню
 *     предлагало «Установить исчезновение». Таймер при этом никуда не девался:
 *     он записан в базе и на той стороне, переписка продолжала удаляться сама,
 *     а человек писал в неё, считая, что сохранится;
 *   — счётчик непрочитанного снимался нулём. Он снимается ровно один раз за
 *     открытие («first open only»), до того как сообщения пометятся
 *     прочитанными, — второй попытки уже не будет, разделитель «новые» за то
 *     открытие не покажется никогда.
 *
 * ПРАВКА. Оба места читают `listConversationsRead`. На `null` показанное
 * остаётся как было, а не заменяется на «ничего нет»; если прежнего значения
 * нет (первое открытие), шапка и меню говорят «не удалось прочитать» вместо
 * «выключено». Запись таймера отсюда не трогали — она и раньше шла от намерения
 * человека (v4.32.750), а не от прочитанного.
 *
 * ГРАНИЦЫ. Удавшееся чтение по-прежнему снимает закрепление и выставляет
 * таймер: неведение не должно замораживать шапку навсегда. Удавшаяся запись
 * таймера снимает пометку сама.
 *
 * Поведение проверяется по форме исходников: поднять здесь настоящий экран
 * нечем (react-test-renderer в проекте нет) — тот же приём, что в
 * convReadOutcome650.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const CHAT = () => read('ui', 'screens', 'ChatScreen.tsx');
const LOCAL = () => read('core', 'storage', 'local.ts');

/** Тело одного места: утверждение не должно ловить совпадение из соседнего. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Строки исходника без комментариев: собственная поясняющая цитата не должна ловиться. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const RELOAD = () =>
  slice(
    CHAT(),
    '// Load pinned message and disappear timer from conversation metadata',
    'useEffect(() => { void reloadThread(); }'
  );

const ON_WRITE = () =>
  slice(CHAT(), "if (tabRef.current !== 'chat') return;", '}, [peerB64, activeProfileId, tabRef]);');

const HEADER = () =>
  slice(CHAT(), ') : disappearMs ? (', ') : presence.label || presence.status ? (');

const MENU_LABEL = () => slice(CHAT(), 'const disappearLabel = disappearMs', 'const blockLabel');

describe('открытие переписки: отказ базы не выдаётся за пустой разговор', () => {
  it('метаданные читаются вариантом с третьим исходом', () => {
    const body = RELOAD();
    expect(body).toContain('const convs = await listConversationsRead(activeProfileId);');
    expect(body).toContain('const convUnknown = convs === null;');
    expect(body).toContain('const conv = convs?.find((c) => c.contactPubB64 === peerB64);');
  });

  it('двузначного чтения на экране не осталось ни одного', () => {
    // Иначе правка держалась бы на том, что новых вызовов не добавят.
    expect(codeOnly(CHAT())).not.toContain('await listConversations(');
  });

  it('закрепление не снимается с экрана по непрочитанному', () => {
    expect(RELOAD()).toContain('} else if (!convUnknown) {\n      setPinnedMsg(null);\n    }');
  });

  it('таймер не сменяется на «выключено» по непрочитанному', () => {
    const body = RELOAD();
    expect(body).toContain('setDisappearUnknown(convUnknown);');
    expect(body).toContain('if (!convUnknown) setDisappearMs(conv?.disappearAfterMs ?? null);');
  });

  it('одноразовое снятие непрочитанного не тратится на отказ базы', () => {
    // `openUnreadRef.current === 0` — это «ещё не снимали». Снять нулём значит
    // потерять разделитель «новые» на всё открытие.
    expect(RELOAD()).toContain(
      'if (!convUnknown && openUnreadRef.current === 0 && (conv?.unreadCount ?? 0) > 0) {'
    );
  });

  it('подписка на записи в чат спрашивает так же', () => {
    const body = ON_WRITE();
    expect(body).toContain('const convs = await listConversationsRead(activeProfileId);');
    expect(body).toContain('setDisappearUnknown(convs === null);');
    expect(body).toContain('if (convs !== null) {');
  });
});

describe('что человек видит, когда не выяснили', () => {
  it('шапка не молчит и не врёт про выключенное исчезновение', () => {
    const body = HEADER();
    expect(body).toContain(') : disappearUnknown ? (');
    expect(body).toContain('Исчезновение: не удалось прочитать');
  });

  it('меню чата говорит то же самое, а не «Установить исчезновение»', () => {
    const body = MENU_LABEL();
    expect(body).toContain(': disappearUnknown');
    expect(body).toContain("? 'Исчезновение: не удалось прочитать'");
  });

  it('пометка заводится своим состоянием, а не выводится из null', () => {
    expect(CHAT()).toContain('const [disappearUnknown, setDisappearUnknown] = useState(false);');
  });
});

describe('ГРАНИЦА: неведение временное', () => {
  it('удавшееся чтение по-прежнему снимает закрепление и ставит таймер', () => {
    const body = RELOAD();
    expect(body).toContain('setPinnedMsg(null);');
    expect(body).toContain('setDisappearMs(conv?.disappearAfterMs ?? null);');
  });

  it('удавшаяся запись таймера снимает пометку сама', () => {
    const body = slice(
      CHAT(),
      'onPress: () => void setDisappearAndSync({ peerPubB64: peerB64, ms })',
      '}),'
    );
    expect(body).toContain('if (res.synced || res.applied) { setDisappearMs(ms); setDisappearUnknown(false); }');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: старая обёртка по-прежнему сводит отказ к пустоте', () => {
    // Пока `listConversations` отвечает `[]` на отказ, любой её вызов с экрана
    // возвращает дефект целиком. Обёртку не убирали: её зовут те места, кому
    // разница не нужна.
    expect(slice(LOCAL(), 'export async function listConversations(', '\n}\n'))
      .toContain('(await listConversationsRead(ownerProfileId)) ?? []');
  });

  it('честные надписи для прочитанного разговора на месте', () => {
    expect(HEADER()).toContain('Исчезают через');
    expect(MENU_LABEL()).toContain("'Установить исчезновение'");
  });

  it('срезы вырезают место, а не весь файл', () => {
    const whole = CHAT().length;
    for (const body of [RELOAD(), ON_WRITE(), HEADER(), MENU_LABEL()]) {
      expect(body.length).toBeGreaterThan(80);
      expect(body.length).toBeLessThan(whole / 4);
    }
    expect(ON_WRITE()).not.toContain('openUnreadRef');
  });

  it('снятие комментариев не съедает код', () => {
    expect(codeOnly('// await listConversations(pid)\nconst a = 1;')).toBe('const a = 1;');
    expect(codeOnly('const b = 2;')).toBe('const b = 2;');
  });
});
