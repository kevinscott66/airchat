/**
 * Пути, на которых экран молчал о неудаче (v4.32.620).
 *
 * Общая черта у всех восьми: отказ ничего не менял на экране. Крутилка
 * гасла, окно закрывалось, поле оставалось пустым — и человек считал, что
 * получилось. Три из них при этом ещё и теряли набранное.
 *
 *   U1 ChatScreen, правка сообщения — поле, баннер правки и черновик
 *      очищаются ДО отправки (иначе экран замирает на время сети). Сбой
 *      только писался в журнал: набранный текст пропадал без следа.
 *   U2 ChatListScreen, рассылка — try/finally БЕЗ catch. Обрыв на середине
 *      списка гасил крутилку, оставляя окно с полным выделением: повтор
 *      отправлял второе сообщение всем, кто уже получил первое.
 *   U3 ChatScreen, опрос в личной переписке — null от sendMessage и
 *      брошенная ошибка обе гасили крутилку молча.
 *   U5 SettingsScreen — Promise.all из двадцати пяти чтений без catch. Отказ
 *      любого отменял ВСЕ setter'ы, и экран выдавал значения по умолчанию за
 *      состояние базы; плюс гонка при быстром переключении профилей.
 *   U6 ProfileScreen, журнал звонков — подписка отбрасывает обновления, пока
 *      открыта не эта вкладка, а снимок при подписке не переигрывается.
 *   U7 VoiceMessage — между скачиванием и созданием проигрывателя стоит сеть;
 *      созданный после размонтирования не попадал в уборку никогда.
 *   U8 ChatSharedMediaModal — prop собеседника меняется на месте, а у чтения
 *      не было отмены: медиа одного человека попадали под имя другого.
 *   U4 StoriesRow — эффект полосы прогресса зависел от goNext, а тот от
 *      inline-обработчика родителя: полоса перезапускалась на каждой записи в
 *      переписку, и истории не листались сами никогда.
 *
 * У каждой проверки ниже есть парная BEFORE: тот же предикат прикладывается к
 * прежнему виду кода и обязан дать другой ответ.
 */
import * as fs from 'fs';
import * as path from 'path';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');

const chat = read('screens/ChatScreen.tsx');
const chatList = read('screens/ChatListScreen.tsx');
const settings = read('screens/SettingsScreen.tsx');
const profile = read('screens/ProfileScreen.tsx');
const voice = read('components/VoiceMessage.tsx');
const shared = read('components/modals/chat/ChatSharedMediaModal.tsx');
const stories = read('components/StoriesRow.tsx');

/** Строки кода без комментариев — пояснение не должно подменять проверку. */
function codeLines(src: string): string[] {
  return src.split('\n').filter((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
}

/** Есть ли в блоке, начатом строкой `head`, строка, удовлетворяющая `pred`. */
function within(src: string, head: string, span: number, pred: (l: string) => boolean): boolean {
  const lines = codeLines(src);
  const at = lines.findIndex((l) => l.includes(head));
  // Отсутствие опоры — это «не выполнено», а не сбой проверки: BEFORE-образцы
  // короткие и якоря в них может не быть вовсе. Что якорь есть в НАСТОЯЩЕМ
  // исходнике, доказывает парная проверка — она обязана быть истинной.
  if (at < 0) return false;
  return lines.slice(at, at + span).some(pred);
}

describe('U1: сбой правки возвращает набранное', () => {
  const restores = (src: string): boolean =>
    within(src, "log.error('chat_edit_failed'", 8, (l) => l.trim() === 'setMsg(newText);')
    && within(src, "log.error('chat_edit_failed'", 8, (l) => l.trim() === 'setEditTarget(target);')
    && within(src, "log.error('chat_edit_failed'", 8, (l) => l.includes('showError(userErrorText(e,'));

  it('поле, баннер и сообщение об ошибке возвращаются', () => {
    expect(restores(chat)).toBe(true);
  });

  it('BEFORE: сбой только писался в журнал', () => {
    const before = [
      '} catch (e) {',
      "  log.error('chat_edit_failed', { err: rawErrorText(e) });",
      '} finally {',
      '  setSending(false);',
      '}',
    ].join('\n');
    expect(restores(before)).toBe(false);
  });
});

describe('U2: обрыв рассылки виден и не рассылает второй раз', () => {
  const honest = (src: string): boolean => {
    const lines = codeLines(src);
    const at = lines.findIndex((l) => l.includes('const delivered: string[] = [];'));
    if (at < 0) return false;
    const block = lines.slice(at, at + 55).join('\n');
    // Отказ без исключения не считается доставкой…
    if (!block.includes('if (svc && (await svc.sendMessage(pubB64, text))) delivered.push(pubB64);')) return false;
    // …обрыв ловится…
    if (!block.includes('} catch (e) {')) return false;
    // …о нём говорят числом…
    if (!block.includes('Рассылка прервалась. Отправлено: ${delivered.length}')) return false;
    // …и уже получившие снимаются с выделения, чтобы повтор их не задел.
    return block.includes('for (const done of delivered) next.delete(done);');
  };

  it('обрыв на середине списка сообщается и снимает отметки', () => {
    expect(honest(chatList)).toBe(true);
  });

  it('BEFORE: try/finally без catch', () => {
    const before = [
      'let sent = 0;',
      'void (async () => {',
      '  try {',
      '    for (const pubB64 of broadcastSelected) {',
      '      if (svc && (await svc.sendMessage(pubB64, text))) sent += 1;',
      '    }',
      '  } finally {',
      '    setBroadcastSending(false);',
      '  }',
      '})();',
    ].join('\n');
    expect(honest(before)).toBe(false);
  });
});

describe('U3: опрос в личной переписке отчитывается об отказе', () => {
  const honest = (src: string): boolean =>
    within(src, 'void svc.sendMessage(peerB64, pollText)', 8, (l) => l.includes('if (!echo) { showError('))
    && within(src, 'void svc.sendMessage(peerB64, pollText)', 8, (l) => l.includes(".catch((e) => { setSending(false); showError(userErrorText(e, 'Не удалось отправить опрос')); });"));

  it('и null, и брошенная ошибка показываются человеку', () => {
    expect(honest(chat)).toBe(true);
  });

  it('BEFORE: обе ветки только гасили крутилку', () => {
    const before = [
      'void svc.sendMessage(peerB64, pollText)',
      '  .then(() => { setSending(false); void appendNewMessages(); })',
      '  .catch(() => setSending(false));',
    ].join('\n');
    expect(honest(before)).toBe(false);
  });
});

describe('U5: настройки не выдают значения по умолчанию за состояние базы', () => {
  const honest = (src: string): boolean => {
    const lines = codeLines(src);
    const at = lines.findIndex((l) => l.includes("privacyPrefGet('privacy_last_seen_visibility')"));
    if (at < 0) return false;
    const block = lines.slice(Math.max(0, at - 4), at + 130).join('\n');
    return block.includes('let cancelled = false;')
      && block.includes('if (cancelled) return;')
      && block.includes("log.error('settings_read_failed'")
      && block.includes('showError(')
      && block.includes('return () => { cancelled = true; };');
  };

  it('отказ чтения показывается, поздний ответ чужого профиля отбрасывается', () => {
    expect(honest(settings)).toBe(true);
  });

  it('BEFORE: ни catch, ни защиты от гонки', () => {
    const before = [
      'useEffect(() => {',
      "  void Promise.all([privacyPrefGet('privacy_last_seen_visibility')]).then(([lsVis]) => {",
      '    setLastSeen(lsVis);',
      '  });',
      '}, [profileRefreshToken]);',
    ].join('\n');
    expect(honest(before)).toBe(false);
  });
});

describe('U6: журнал звонков перечитывается при открытии', () => {
  const honest = (src: string): boolean =>
    within(src, 'setCallLogVisible(true);', 4, (l) => l.trim() === 'setCallLogEntries(getCallLog());')
    || within(src, 'setCallLogEntries(getCallLog());', 4, (l) => l.trim() === 'setCallLogVisible(true);');

  it('снимок берётся заново, а не остаётся от монтирования вкладки', () => {
    expect(honest(profile)).toBe(true);
  });

  it('BEFORE: окно открывалось на том, что накопила подписка', () => {
    const before = 'onPress={() => setCallLogVisible(true)}';
    expect(honest(before)).toBe(false);
  });
});

describe('U7: проигрыватель не создаётся после размонтирования', () => {
  const honest = (src: string): boolean => {
    const lines = codeLines(src);
    if (!lines.some((l) => l.includes('useEffect(() => () => { mountedRef.current = false; }, []);'))) return false;
    const at = lines.findIndex((l) => l.includes('const snd = createAudioPlayer('));
    if (at < 1) return false;
    return lines[at - 1].trim() === 'if (!mountedRef.current) return;';
  };

  it('перед созданием проверяется, жив ли экран', () => {
    expect(honest(voice)).toBe(true);
  });

  it('BEFORE: создавался всегда, а уборка знала только про state', () => {
    const before = [
      'const playUri = await resolveBlobToLocalFile(blob, "m4a");',
      'const snd = createAudioPlayer({ uri: playUri }, { updateInterval: 100 });',
    ].join('\n');
    expect(honest(before)).toBe(false);
  });
});

describe('U8: медиа одного собеседника не попадают под имя другого', () => {
  const honest = (src: string): boolean => {
    const lines = codeLines(src);
    const at = lines.findIndex((l) => l.includes('let cancelled = false;'));
    if (at < 0) return false;
    const block = lines.slice(at, at + 60).join('\n');
    // v4.32.640: обе выборки окна проверяют отмену ДО того, как что-то
    // применить. Раньше медиа применялись через `if (!cancelled) setItems`,
    // теперь у чтения три исхода и проверка стоит первой строкой — важна не
    // форма, а то, что ни одна ветка не пишет в состояние после отмены.
    const guards = block.match(/if \(cancelled\) return;/g) ?? [];
    return guards.length >= 2
      && !block.includes('.then(setItems)')
      && block.includes('return () => { cancelled = true; };');
  };

  it('смена prop отменяет прежнее чтение', () => {
    expect(honest(shared)).toBe(true);
  });

  it('BEFORE: результат применялся всегда', () => {
    const before = [
      'void listConversationMedia(contactPubB64, ownerProfileId).then(setItems);',
      '}, [active, contactPubB64, ownerProfileId]);',
    ].join('\n');
    expect(honest(before)).toBe(false);
  });

  it('BEFORE: отмена была объявлена, но медиа применялись без неё', () => {
    // Контроль на сам предикат: одной проверки отмены мало, их две.
    const before = [
      'let cancelled = false;',
      'void listConversationMedia(contactPubB64, ownerProfileId).then(setItems);',
      'void loadLinks().then(() => {',
      'if (cancelled) return;',
      '});',
      'return () => { cancelled = true; };',
    ].join('\n');
    expect(honest(before)).toBe(false);
  });
});

describe('U4: полоса истории не перезапускается на каждый рендер родителя', () => {
  const honest = (src: string): boolean => {
    const lines = codeLines(src);
    if (!lines.some((l) => l.includes('goNextRef.current = goNext;'))) return false;
    const at = lines.findIndex((l) => l.includes('anim.start(({ finished }'));
    if (at < 0) return false;
    if (!lines[at].includes('goNextRef.current()')) return false;
    // Зависимости эффекта не должны содержать сам goNext.
    const deps = lines.slice(at, at + 4).find((l) => l.includes('}, ['));
    return !!deps && !deps.includes('goNext') && deps.includes('index');
  };

  it('обработчик берётся из ref, а зависимости — только устойчивые', () => {
    expect(honest(stories)).toBe(true);
  });

  it('BEFORE: goNext стоял в зависимостях', () => {
    const before = [
      'anim.start(({ finished }: { finished: boolean }) => { if (finished) goNext(); });',
      'return () => anim.stop();',
      '}, [index, goNext, progressAnim, replyPaused]);',
    ].join('\n');
    expect(honest(before)).toBe(false);
  });
});
