/**
 * v4.32.725: «Повторить» больше не стирает сообщение, которое не ушло.
 *
 * Дефект. Повтор текстового сообщения шёл иначе, чем повтор с вложением:
 * новой отправкой `sendMessage`, а следом — безусловным `deleteMessageLocally`
 * исходной строки. `sendMessage` объявлен `Promise<string | null>` и отвечает
 * null, НЕ бросая: исчерпан часовой лимит, не получен симметричный ключ
 * (`dm_no_session`), не разобрался did собеседника. Отсутствие ключа — ровно та
 * причина, по которой сообщение и оказалось в «не доставлено», то есть самый
 * вероятный случай при нажатии «Повторить».
 *
 * Чем это кончалось. `catch` не срабатывал, строку удаляли жёстко, копию в
 * «Недавно удалённые» тут никто не кладёт. Пузырь «не доставлено» пропадал,
 * нового не появлялось — набранный текст исчезал из переписки навсегда, а
 * человек видел только общий баннер про лимит или про канал.
 *
 * Развязка. Повтор идёт тем же `retrySendDm`, что и с вложением: он сохраняет
 * id и время, переписывает строку в «доставлено», отвечает boolean и при отказе
 * не трогает ничего. Удалять нечего — значит и терять нечего.
 *
 * Проверка идёт по исходнику: экран целиком в jest не поднять (та же причина,
 * что в `chatDeleteTrash631.test.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'ChatScreen.tsx'), 'utf8');
const MESSAGING = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'core', 'social', 'messaging.ts'),
  'utf8'
);

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

const CODE = codeOnly(SRC);

/** Тело обработчика «Повторить» — от объявления до его зависимостей. */
const RETRY = (() => {
  const a = CODE.indexOf('const retryFailedMessage = useCallback');
  expect(a).toBeGreaterThan(0);
  const b = CODE.indexOf('}, [peerB64, appendNewMessages, isBlocked]);', a);
  expect(b).toBeGreaterThan(a);
  return CODE.slice(a, b);
})();

describe('повтор не удаляет исходную строку', () => {
  it('в обработчике не осталось ни удаления, ни новой отправки', () => {
    expect(RETRY).not.toContain('deleteMessageLocally');
    expect(RETRY).not.toContain('svc.sendMessage(');
  });

  it('повтор один на оба случая и отвечает признаком', () => {
    expect(RETRY).toContain('const ok = await svc.retrySendDm({');
    expect((RETRY.match(/retrySendDm\(/g) ?? []).length).toBe(1);
    expect(RETRY).toContain('if (!ok) {');
    expect(RETRY).toContain('return;');
  });

  it('об отказе говорят, и словами про сохранность', () => {
    expect(RETRY).toContain("'Не удалось отправить, вложение сохранено'");
    expect(RETRY).toContain("'Не удалось отправить. Сообщение осталось в переписке'");
  });

  it('вложения по-прежнему идут ссылками, а не путями файлов', () => {
    expect(RETRY).toContain('const mediaCids = parseMediaCidsColumn(row.mediaCids);');
    expect(RETRY).toContain('mediaCids,');
    expect(RETRY).toContain('messageId: row.id,');
    expect(RETRY).toContain('ts: row.createdAt,');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('sendMessage по-прежнему отвечает null, не бросая', () => {
    const code = codeOnly(MESSAGING);
    const at = code.indexOf('async sendMessage(');
    expect(at).toBeGreaterThan(0);
    expect(code.slice(at, at + 400)).toContain('Promise<string | null>');
  });

  it('retrySendDm отвечает boolean и при отказе ничего не трогает', () => {
    const code = codeOnly(MESSAGING);
    const at = code.indexOf('async retrySendDm(payload: DmRetryPayload): Promise<boolean> {');
    expect(at).toBeGreaterThan(0);
    const head = code.slice(at, at + 700);
    expect(head).toContain('if (!sym) {');
    expect(head).toContain('return false;');
    expect(head).toContain('if (!peerDid) return false;');
  });

  it('копии в «Недавно удалённые» повтор не делает — терять было бы насовсем', () => {
    expect(RETRY).not.toContain('saveRecentlyDeleted');
  });
});
