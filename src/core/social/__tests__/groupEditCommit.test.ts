/**
 * v4.32.530: правка сообщения группы — запись, а потом уже рассылка.
 *
 * Три звена одной цепочки: потолок текста в конверте, ответ базы о том,
 * применилась ли правка, и поведение экрана, когда она не применилась.
 * Поведение самой записи проверяется по исходнику: подменить SQLite и DEK
 * здесь дороже, чем польза, а именно порядок «сначала успех, потом fanout»
 * и есть то, что ломалось.
 */
import fs from 'fs';
import path from 'path';

import { decodeGroupCtlEnvelope, encodeGroupCtlEnvelope } from '../groupControlEnvelope';
import { MAX_MESSAGE_TEXT } from '../messageTextLimit';

const SRC = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

const LOCAL = SRC('core/storage/local.ts');
const GROUP_MSG = SRC('core/social/groupMessaging.ts');
const SCREEN = SRC('ui/screens/GroupsScreen.tsx');
const CTL = SRC('core/social/groupControlEnvelope.ts');

/** Тело одной экспортируемой функции огромного файла. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + 10);
  const end = rest.indexOf('\nexport ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('потолок правки совпадает с потолком сообщения', () => {
  const ctl = (text: unknown): string =>
    encodeGroupCtlEnvelope({ groupId: 'g1', ts: 1, op: 'edit', msgId: 'm1', text } as never);

  it('длинная, но допустимая правка доезжает целиком', () => {
    const long = 'т'.repeat(MAX_MESSAGE_TEXT);
    expect(decodeGroupCtlEnvelope(ctl(long))).toMatchObject({ op: 'edit', text: long });
  });

  it('за потолком конверт отбрасывается, а не подрезается', () => {
    expect(decodeGroupCtlEnvelope(ctl('т'.repeat(MAX_MESSAGE_TEXT + 1)))).toBeNull();
  });

  it('прежнего собственного числа в кодеке больше нет', () => {
    expect(CTL).not.toContain('slice(0, 4096)');
    expect(CTL).toContain('withinMessageTextLimit(env.text)');
  });
});

describe('исходники: запись отвечает, а рассылка ждёт ответа', () => {
  it('updateGroupMessageText возвращает результат, а не void', () => {
    const body = fnBody(LOCAL, 'updateGroupMessageText');
    expect(body).toContain('Promise<boolean>');
    expect(body).toContain('anyChanged(res)');
    expect(body).toContain('return false;');
    expect(body).toContain('return true;');
    // сигнал о записи только за настоящим изменением — см. writeEcho
    expect(body).not.toMatch(/\n {4}emitChatWrites\(\);\n {2}} catch/);
  });

  it('входящая правка из сети не объявляется применённой вслепую', () => {
    expect(GROUP_MSG).toContain('const applied = await updateGroupMessageText(env.msgId, env.text, pid);');
    expect(GROUP_MSG).toContain('group_ctl_edit_not_applied');
    expect(GROUP_MSG).not.toContain("if (env.op === 'edit') await updateGroupMessageText(");
  });

  it('экран рассылает правку только после успешной локальной записи', () => {
    const start = SCREEN.indexOf('const applied = await updateGroupMessageText(orig.id, t, pid);');
    expect(start).toBeGreaterThan(-1);
    const fanout = SCREEN.indexOf("{ op: 'edit', msgId: orig.id, text: t }");
    expect(fanout).toBeGreaterThan(start);
    const branch = SCREEN.slice(start, fanout);
    expect(branch).toContain('if (!applied)');
    expect(branch).toContain('Не удалось сохранить правку');
    // прежняя форма — .then() + .finally() без .catch — не должна вернуться
    expect(SCREEN).not.toContain('void updateGroupMessageText(orig.id, t, pid).then(');
  });

  it('правка снимает черновик так же, как обычная отправка', () => {
    const editAt = SCREEN.indexOf('const applied = await updateGroupMessageText(orig.id, t, pid);');
    const draftAt = SCREEN.lastIndexOf('clearGroupDraft();', editAt);
    expect(draftAt).toBeGreaterThan(-1);
    // между снятием черновика и правкой не должно быть ветки обычной отправки
    expect(SCREEN.slice(draftAt, editAt)).not.toContain('Vibration.vibrate');
  });
});
