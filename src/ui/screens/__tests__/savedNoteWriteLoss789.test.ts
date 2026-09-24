/**
 * «Заметки для себя» больше не пропадают молча (v4.32.789).
 *
 * Дефект. У переписки с собой нет ни сети, ни конверта, ни очереди повторной
 * отправки: строка в базе — ЕДИНСТВЕННЫЙ след написанного. Все три её ветки
 * (текст, голосовое, GIF) клали строку гасящей `upsertChatMessage`, а та зовёт
 * проверяемую форму и выбрасывает её ответ. Заметить отказ было нечем.
 *
 * Цена. Поле ввода уже очищено, черновик снят, вибрация отработала, список
 * прокручен — а строки нет. Пузырь не появляется, ошибки не появляется тоже:
 * заметка исчезает совсем. У текста вдобавок `touchConversation` звался
 * безусловно, и в списке чатов оставалось превью сообщения, которого в
 * переписке нет. У голосового в кэше оставался осиротевший файл записи.
 *
 * Обычная отправка защищена ровно от этого с v4.32.781: `saveRow` отвечает
 * исходом, и `'failed'` возвращает текст в поле ответом `'refused'`. Сюда
 * защита просто не дошла.
 *
 * Правка. Все три ветки пишут проверяемой формой. Текст при отказе возвращает
 * набранное в поле и говорит об этом вслух; голосовое и GIF бросают — их
 * общий `catch` и покажет ошибку, и уберёт осиротевший файл.
 *
 * Проверка идёт по исходнику: экран целиком в jest не поднять (та же причина,
 * что в `chatRetryLoss725.test.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';

/** Код без комментариев: пояснение не должно подменять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CHAT = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'ChatScreen.tsx'), 'utf8'));
const MESSAGING = codeOnly(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'core', 'social', 'messaging.ts'), 'utf8'),
);
const LOCAL = codeOnly(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'core', 'storage', 'local.ts'), 'utf8'),
);

/** Кусок исходника между двумя опорами. Обе обязаны найтись и идти по порядку. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Ветка «заметка для себя» в отправке текста. */
const TEXT = between(CHAT, 'if (isSavedMessages) {\n      const ts = Date.now();', "\n    const optimistic:");
/** Ветка «заметка для себя» в отправке голосового. */
const VOICE = between(CHAT, 'const voiceText = makeVoiceText(', '} else {');
/** Ветка «заметка для себя» в отправке GIF. */
const GIF = between(CHAT, "void touchConversation(peerB64, activeProfileId, '🎞 GIF'", 'sendGif');

describe('единственная копия заметки пишется проверяемой формой', () => {
  it('текст: отказ возвращает набранное в поле и говорит об этом', () => {
    expect(TEXT).toContain("if ((await upsertChatMessageChecked(row)) === 'failed') {");
    // v4.32.873: поле и черновик за ним ставятся одной формой. Прежние две
    // строки писали `setMsg` и `msgRef`, но не черновик: текст возвращался на
    // экран, а в базе за ним ничего не стояло — выход из переписки его уносил.
    expect(TEXT).toContain('putComposer(text);');
    expect(CHAT).toContain('const putComposer = useCallback((next: string) => {\n    msgRef.current = next;');
    expect(CHAT).toContain('    saveDraft(next);\n  }, [saveDraft]);');
    expect(TEXT).toContain('setReplyTo(replyRef ?? null);');
    expect(TEXT).toContain("showError('Заметка не сохранилась. Попробуйте ещё раз');");
    expect(TEXT).toContain("log.error('saved_note_row_failed'");
    // Гасящей записи на этом пути больше нет.
    expect(TEXT).not.toContain('await upsertChatMessage(row);');
  });

  it('текст: пометка в списке чатов ставится только после удавшейся записи', () => {
    // Иначе в списке чатов остаётся превью сообщения, которого в переписке нет.
    const guard = TEXT.indexOf("if ((await upsertChatMessageChecked(row)) === 'failed') {");
    const ret = TEXT.indexOf('return;', guard);
    const touch = TEXT.indexOf('void touchConversation(', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(guard);
    expect(touch).toBeGreaterThan(ret);
  });

  it('голосовое: отказ бросает — его поймает общий catch', () => {
    expect(VOICE).toContain('const wrote = await upsertChatMessageChecked({');
    expect(VOICE).toContain("if (wrote === 'failed') throw new Error('Заметка не сохранилась');");
    expect(VOICE).not.toContain('await upsertChatMessage({');
  });

  it('голосовое: осиротевший файл записи убирается тем же catch', () => {
    // Строки нет — значит и файлу в кэше делать нечего.
    const tail = between(CHAT, "log.error('voice_send_failed'", 'const sendGif');
    expect(CHAT).toContain('await deleteCachedFileUris([result.uri]).catch(() => {});');
    expect(tail).toContain("showError(userErrorText(e, 'Не удалось отправить голосовое'));");
  });

  it('GIF: отказ бросает — его поймает общий catch', () => {
    const branch = between(CHAT, 'const sendGif = useCallback', 'const CHAT_CMDS');
    expect(branch).toContain('const wrote = await upsertChatMessageChecked({');
    expect(branch).toContain("if (wrote === 'failed') throw new Error('Заметка не сохранилась');");
    expect(branch).toContain("showError(userErrorText(e, 'Не удалось отправить GIF'));");
    expect(branch).not.toContain('await upsertChatMessage({');
  });

  it('ни одна ветка заметок больше не пишет молча', () => {
    expect(GIF).not.toContain('upsertChatMessage(');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: осознанные молчаливые записи остались', () => {
  it('живая геолокация по-прежнему пишет гасящей формой', () => {
    // Её строку переписывает каждый такт сессии: отказ чинится сам собой, а
    // ошибка на экране мешала бы разговору каждые полминуты.
    // v4.32.833: записей за такт стало две — «отправляется» и исход посылки, —
    // но обе по-прежнему гасящие, и ровно по той же причине.
    expect(CHAT).toContain("await upsertChatMessage({ ...row, status: 'sending' });");
    expect(CHAT).toContain("await upsertChatMessage({ ...row, status: ok ? 'sent' : 'failed' });");
    expect(CHAT).toContain('        const row = {\n          id: payload.liveId,');
  });

  it('обычная отправка защищена своим способом и он не тронут (v4.32.781)', () => {
    expect(MESSAGING).toContain('return await upsertChatMessageChecked(row);');
    expect(MESSAGING).toContain(
      "if ((await measureAsync('dm_db_upsert_pending', () => saveRow(pending))) === 'failed') {",
    );
    expect(MESSAGING).toContain("return { outcome: 'refused', cid: null };");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('гасящая форма выбрасывает ответ проверяемой', () => {
    // Вот почему отказ было нечем заметить: возвращать было нечего.
    expect(LOCAL).toContain('export async function upsertChatMessage(row: ChatMessageRow): Promise<void> {');
    expect(LOCAL).toContain('  await upsertChatMessageChecked(row);');
  });

  it('проверяемая форма называет исход словом', () => {
    expect(LOCAL).toContain("export type ChatUpsertWrite = 'written' | 'failed';");
    expect(LOCAL).toContain(
      'export async function upsertChatMessageChecked(row: ChatMessageRow): Promise<ChatUpsertWrite> {',
    );
  });

  it('у заметок для себя нет ни сети, ни очереди повтора', () => {
    // Если это перестанет быть правдой, правку можно будет пересмотреть.
    expect(TEXT).not.toContain('getMessagingService()');
    expect(TEXT).not.toContain('sendMessageResult');
    expect(TEXT).toContain('cid: `local:${ts}`,');
  });
});
