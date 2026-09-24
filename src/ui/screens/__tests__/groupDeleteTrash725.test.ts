/**
 * v4.32.725: в группах «Недавно удалённые» стали обещанием, а не надписью.
 *
 * Дефект первый. Одиночное удаление копию клало, но её судьбу не спрашивало:
 * `kvUpdateSecretScoped` отвечает 'written' | 'failed' | 'unreadable' и НЕ
 * бросает. 'unreadable' — прежняя ячейка корзины не расшифровалась, и модуль
 * намеренно отказывается писать поверх чужого шифртекста; 'failed' — запись не
 * легла (полный диск, отказ базы). Следом шло жёсткое удаление и рассылка
 * надгробия участникам. `runGuardedOp` ловит только брошенное, поэтому человек
 * узнавал о пропаже, открыв пустую корзину — уже после того, как сообщения не
 * стало.
 *
 * Дефект второй. Удаление пачкой не заходило в корзину вообще: ни одного
 * вызова. Выделить десять сообщений и нажать «Удалить» значило потерять их
 * насовсем — при том что экран корзины у групп есть, одиночное удаление копию
 * кладёт, а в личной переписке ту же дыру закрыли в v4.32.631.
 *
 * Проверка идёт по исходнику: экран целиком в jest не поднять (та же причина,
 * что в `chatDeleteTrash631.test.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'GroupsScreen.tsx'), 'utf8');

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
  const body = () =>
    slice('const saveGrpRecentlyDeleted = useCallback', '}, [pid, group.id]);');

  it('ПРОВЕРКА НЕ ПУСТАЯ: помощник объявлен и возвращает признак', () => {
    expect(CODE).toContain(
      'const saveGrpRecentlyDeleted = useCallback(async (msg: GroupMessageRow): Promise<boolean> =>'
    );
  });

  it('результат записи прочитан, а не выброшен', () => {
    const b = body();
    expect(b).toContain('const res = await kvUpdateSecretScoped(');
    expect(b).toContain("return res === 'written';");
    expect(b).toContain("log.warn('group_recently_deleted_copy_failed'");
    expect(b).toContain('return false;');
  });
});

describe('удаление одного сообщения', () => {
  const body = () => slice("'Удалить', style: 'destructive',", "'group_msg_delete_failed'");

  it('копия делается до удаления и её итог запомнен', () => {
    const b = body();
    const kept = b.indexOf('const kept = await saveGrpRecentlyDeleted(msg);');
    const del = b.indexOf('await deleteGroupMessageChecked(msg.id, pid);');
    expect(kept).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(kept);
  });

  it('о несохранившейся копии сказано человеку', () => {
    expect(body()).toContain(
      "if (!kept) showError('Сообщение удалено. Копия в «Недавно удалённые» не сохранилась');"
    );
  });

  it('своя ветка записи в корзину из обработчика ушла — она одна на оба случая', () => {
    expect(body()).not.toContain('kvUpdateSecretScoped(');
  });
});

describe('удаление пачкой', () => {
  // v4.32.888: вырезка начиналась с `Alert.alert('Удалить выбранные?'` одной
  // строкой — тело окна выросло, и заголовок переехал на свою. Границей берём
  // сам заголовок: он и есть начало этого подтверждения.
  const body = () => slice("'Удалить выбранные?'", "'ui_group_delete_selected_failed'");

  it('копия делается для каждого выделенного', () => {
    const b = body();
    expect(b).toContain('if (!(await saveGrpRecentlyDeleted(m))) allKept = false;');
    const copy = b.indexOf('saveGrpRecentlyDeleted');
    const del = b.indexOf('await Promise.all(ids.map((id) => deleteGroupMessageChecked(id, pid)));');
    expect(copy).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(copy);
  });

  it('о частичной потере сказано человеку', () => {
    expect(body()).toContain(
      "if (!allKept) showError('Часть сообщений удалена без копии в «Недавно удалённые»');"
    );
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('kvUpdateSecretScoped по-прежнему отвечает неуспехом, не бросая', () => {
    const local = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'core', 'storage', 'local.ts'),
      'utf8'
    );
    const at = local.indexOf('export async function kvUpdateSecretScoped(');
    expect(at).toBeGreaterThan(0);
    const head = local.slice(at, at + 1200);
    expect(head).toContain("return 'unreadable';");
    expect(head).toContain("'written'");
    expect(head).toContain("'failed'");
  });

  it('удаление в группе жёсткое: восстановить можно только из корзины', () => {
    expect(CODE).toContain('await deleteGroupMessageChecked(msg.id, pid);');
    expect(CODE).toContain('const GRP_RECENTLY_DELETED_TTL_MS');
  });
});
