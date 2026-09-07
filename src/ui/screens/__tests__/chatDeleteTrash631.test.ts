/**
 * «Недавно удалённые» — обещание, за которое отвечает удаление (v4.32.631).
 *
 * Копия в корзину писалась в try с пустым catch, а её
 * результат — 'written' | 'failed' | 'unreadable' — выбрасывался. Дальше шло
 * само удаление и бодрое «Сообщение удалено». Если ячейка корзины не
 * открылась или запись не легла, восстанавливать было нечего, и узнать об
 * этом человек мог только открыв пустой список — уже после того, как
 * сообщения не стало.
 *
 * Удаление пачкой не заходило в корзину вовсе: те же слова «Удалить», тот же
 * ожидаемый откат — и ноль копий.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'ChatScreen.tsx'), 'utf8');

/** Код без комментариев: пояснение не должно подменять проверку. */
const CODE = SRC.split('\n')
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

function slice(from: string, to: string): string {
  const a = CODE.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = CODE.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return CODE.slice(a, b);
}

describe('копия в корзину отвечает, легла ли она', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: saveRecentlyDeleted объявлен и возвращает признак', () => {
    expect(CODE).toContain('const saveRecentlyDeleted = useCallback(async (row: ChatMessageRow): Promise<boolean> =>');
  });

  it('результат записи прочитан, а не выброшен', () => {
    const body = slice('const saveRecentlyDeleted = useCallback', '}, [activeProfileId, peerB64]);');
    expect(body).toContain('const res = await kvUpdateSecretScoped(');
    expect(body).toContain("return res === 'written';");
    // Провал больше не гасится молча: он и в журнал, и наружу.
    expect(body).toContain("log.warn('chat_recently_deleted_copy_failed'");
    expect(body).toContain('return false;');
    expect(body).not.toMatch(/catch\s*\{\s*\/\* ignore \*\/\s*\}/);
  });

  it('неподходящая строка — не отказ: медиа и длинное в корзину не кладутся по замыслу', () => {
    const body = slice('const saveRecentlyDeleted = useCallback', '}, [activeProfileId, peerB64]);');
    expect(body).toContain("if (!row.text || row.text.length >= 2000 || row.text.startsWith('\\x01')) return true;");
  });
});

describe('удаление одного сообщения', () => {
  const body = () => slice("{ label: 'Удалить у себя'", "'ui_chat_delete_local_failed'");

  it('копия делается до удаления', () => {
    const b = body();
    const copy = b.indexOf('const kept = await saveRecentlyDeleted(q);');
    const del = b.indexOf('await svc2.deleteMessageLocally(q.id);');
    expect(copy).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(copy);
  });

  it('«Сообщение удалено» говорится только при сохранившейся копии', () => {
    const b = body();
    expect(b).toContain("if (kept) showSuccess('Сообщение удалено');");
    expect(b).toContain("else showError('Сообщение удалено. Копия в «Недавно удалённые» не сохранилась');");
  });
});

describe('удаление выбранных сообщений', () => {
  const body = () => slice("'Удалить выбранные?'", "'ui_chat_delete_selected_failed'");

  it('пачка тоже попадает в корзину, и до удаления', () => {
    const b = body();
    const copy = b.indexOf('await saveRecentlyDeleted(m)');
    const del = b.indexOf('svc.deleteMessageLocally(id)');
    expect(copy).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(copy);
  });

  it('копии кладутся по одной: параллельные правки одной ячейки затирают друг друга', () => {
    const b = body();
    expect(b).toMatch(/for \(const m of msgs\) \{/);
    expect(b).not.toMatch(/Promise\.all\([^)]*saveRecentlyDeleted/);
  });

  it('о недоложенных копиях говорят', () => {
    expect(body()).toContain("showError('Часть сообщений удалена без копии в «Недавно удалённые»')");
  });
});
