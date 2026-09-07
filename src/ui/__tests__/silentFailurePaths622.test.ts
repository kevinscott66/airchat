import fs from 'fs';
import path from 'path';

/**
 * Молчащие отказы круга 4.32.622 — храповик по исходникам.
 *
 * Каждая из этих правок живёт в обработчике, который нельзя вызвать из теста
 * без половины экрана вокруг: отказ `profileManager.init()`, переработка ячейки
 * FlashList, отменённый нативный сканер. Поведенческие тесты на них стоили бы
 * дороже самих правок, поэтому здесь проверяется форма кода — чтобы следующая
 * правка этих мест не сняла защиту молча.
 */

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');

/** Строки кода без комментариев — пояснение не должно подменять проверку. */
function codeLines(src: string): string[] {
  return src.split('\n').filter((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).map((l) => l.trim());
}

/** Идут ли эти строки кода подряд (комментарии между ними допустимы). */
function hasSequence(src: string, seq: readonly string[]): boolean {
  const lines = codeLines(src);
  for (let i = 0; i + seq.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < seq.length; j += 1) {
      if (lines[i + j] !== seq[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

const feed = read('screens/FeedScreen.tsx');
const groups = read('screens/GroupsScreen.tsx');
const contacts = read('screens/ContactsScreen.tsx');
const announce = read('groupSendAnnounce.ts');
const pollModal = read('components/modals/groups/GroupPollCreatorModal.tsx');
const pollBubble = read('screens/groups-components/PollBubble.tsx');
const dmPollBubble = read('screens/chat-components/DmPollBubble.tsx');

describe('лента: отказ profileManager.init() не запирает публикацию', () => {
  it('проверка не пустая: ветвей публикации через init ровно две', () => {
    // Появилась третья — у неё тоже должен быть .catch, допишите проверку.
    expect(feed.split('void profileManager.init().then(').length - 1).toBe(2);
  });

  it('ветка опроса снимает замок и называет беду', () => {
    // Внутренний catch (отказ publishFeedPost) говорит в другом порядке —
    // порядок здесь и отличает внешнюю ветку от внутренней.
    expect(hasSequence(feed, [
      '}).catch((e: unknown) => {',
      'publishLockRef.current = false;',
      "showError(userErrorText(e, 'Не удалось опубликовать опрос'));",
    ])).toBe(true);
  });

  it('текстовая ветка возвращает черновик, снимает замок и называет беду', () => {
    expect(hasSequence(feed, [
      '}).catch((e: unknown) => {',
      'setDraft(textSnap);',
      'setUris(urisSnap);',
      'setPickedDocs(docsSnap);',
      'publishLockRef.current = false;',
      "showError(userErrorText(e, t('feed.publishFailed')));",
    ])).toBe(true);
  });
});

describe('группы: асинхронные действия не молчат', () => {
  it('удаление сообщения идёт через runGuardedOp с меткой', () => {
    expect(groups).toContain("}, 'Не удалось удалить сообщение', 'group_msg_delete_failed');");
  });

  it('«отметить непрочитанным и выйти» идёт через runGuardedOp', () => {
    expect(hasSequence(groups, [
      'const markUnreadAndLeave = (): void => runGuardedOp(async () => {',
      'await markGroupUnread(group.id, pid);',
      'onBack();',
      "}, 'Не удалось отметить непрочитанным');",
    ])).toBe(true);
  });

  it('сорванная реакция пишется в журнал и показывается человеку', () => {
    expect(hasSequence(groups, [
      "log.error('group_reaction_failed', { err: rawErrorText(e) });",
      "showError(userErrorText(e, 'Не удалось поставить реакцию'));",
      '} finally {',
      'setQuickReact(null);',
    ])).toBe(true);
  });

  it('создатель опроса получает ответ: отказ — false, приём — true', () => {
    expect(hasSequence(groups, [
      "showError(userErrorText(err, 'Проверьте вопрос и варианты ответа'));",
      'return false;',
    ])).toBe(true);
    expect(groups).toContain('          return true;\n        }}');
  });

  it('рассылка группе сообщает о сорвавшейся отправке', () => {
    expect(hasSequence(announce, [
      '}).catch((e: unknown) => {',
      "showError(userErrorText(e, 'Не удалось разослать сообщение группе'));",
    ])).toBe(true);
  });
});

describe('контакты: отказ чтения, сканер', () => {
  it('сорванное чтение не рисуется как пустая записная книжка', () => {
    expect(hasSequence(contacts, [
      'const read = await listContactsRead();',
      'if (!shouldApplyRows(read)) {',
      "showError('Не удалось прочитать контакты. Потяните список вниз, чтобы повторить.');",
      'return;',
      '}',
    ])).toBe(true);
  });

  it('«потянуть вниз» сообщает об отказе, а не глохнет', () => {
    expect(contacts).toContain("showError(userErrorText(e, 'Не удалось обновить контакты'));");
  });

  it('подписка сканера живёт в ref и снимается при размонтировании', () => {
    expect(contacts).toContain('scanSubRef.current = sub;');
    expect(contacts).toContain('useEffect(() => dropScanSub, [dropScanSub]);');
  });

  it('успешный запуск сканера НЕ снимает подписку', () => {
    // iOS отдаёт обещание launchScanner сразу после показа контроллера
    // (CameraViewModule.swift), результат приходит позже — снятие подписки
    // здесь выключило бы сканирование целиком.
    expect(hasSequence(contacts, [
      "await CameraView.launchScanner({ barcodeTypes: ['qr'] });",
      "log.info('ui_contacts_scanner_gms_done', {});",
      'return;',
    ])).toBe(true);
  });

  it('отмена молчит, а настоящий отказ сканера — нет', () => {
    expect(hasSequence(contacts, [
      'if (/cancel/i.test(msg)) return;',
      'if (!/unavailable|not available|play services/i.test(msg)) {',
      "showError(userErrorText(e, 'Не удалось открыть сканер QR'));",
      'return;',
      '}',
    ])).toBe(true);
  });
});

describe('создание опроса: индекс ответа и судьба формы', () => {
  it('верный ответ пересчитывается по отправляемому списку', () => {
    expect(pollModal).toContain('const kept: number[] = [];');
    expect(pollModal).toContain('const answer = kept.indexOf(correctAnswer);');
  });

  it('проверки говорят вслух, а не возвращаются молча', () => {
    expect(pollModal).toContain("if (!q) { showError('Введите вопрос'); return; }");
    expect(pollModal).toContain("if (opts.length < 2) { showError('Нужно хотя бы два непустых варианта ответа'); return; }");
    expect(codeLines(pollModal)).not.toContain('if (!q) return;');
  });

  it('форма чистится только после приёма', () => {
    expect(hasSequence(pollModal, [
      'const accepted = onCreate(q, opts, isQuiz ? answer : undefined, anonymous || undefined, (!isQuiz && allowMultiple) || undefined);',
      'if (!accepted) return;',
      "setQuestion('');",
    ])).toBe(true);
  });
});

describe.each([
  ['PollBubble', pollBubble],
  ['DmPollBubble', dmPollBubble],
])('%s: переработанная ячейка не показывает чужой опрос', (_name, src) => {
  it('состояние сбрасывается на смене messageId прямо в рендере', () => {
    expect(hasSequence(src, [
      'const [shownId, setShownId] = useState(messageId);',
      'if (shownId !== messageId) {',
      'setShownId(messageId);',
      'setVotes([]);',
      'setIsClosed(false);',
      '}',
    ])).toBe(true);
  });

  it('признак завершения присваивается, а не «включается» навсегда', () => {
    expect(src).toContain("setIsClosed(closed === '1');");
    // Упоминание в пояснении не считается — сравниваем только строки кода.
    expect(codeLines(src).filter((l) => l.includes('setIsClosed(true)'))).toEqual([]);
  });
});
