/**
 * v4.32.989: отметка «я сам просился» перестала теряться молча.
 *
 * Дефект. Переход по ссылке-приглашению с одобрением делает две вещи: шлёт
 * заявку администратору и записывает у себя отметку «просился именно к этому
 * администратору». Вторая — не украшение: она единственная пускает его
 * приглашение в аккаунт, где включено «в группы добавляют только контакты», а
 * администратора в контактах нет (v4.32.465). Писалась отметка через
 * `profileKvSet`, объявленный `Promise<void>`: отказ базы был неотличим от
 * удачи.
 *
 * Цена. Момент записи — холодный старт приложения по ссылке, то есть самый
 * занятый. Не легла отметка — человек читает «Запрос на вступление отправлен
 * администратору», администратор видит заявку и нажимает «Принять», а
 * приглашение на этой стороне отбрасывается: `isInviteTrusted` читает отметку
 * успешно, её нет, администратора в контактах нет — приглашение не доверенное.
 * Обе стороны уверены, что всё в порядке, группа не появляется никогда.
 *
 * Правка. Запись идёт через `scopedKvSetCheckedFor`, отвечающий `boolean`, и
 * при отказе всплывающая плашка называет расхождение, а не успех.
 *
 * Границы. Жалоба на неушедшую заявку по-прежнему главнее: если конверт не
 * ушёл, отметка не спасает, и говорить о ней — сбивать с толку. App.tsx в jest
 * не поднимается, поэтому место правки проверяется по исходнику, а текстовка —
 * вызовами.
 */
import * as fs from 'fs';
import * as path from 'path';

// Текстовка тянет за собой controlFanout, а тот — службу отправки с uuid:
// в jest этот путь не нужен вовсе, здесь проверяются одни слова.
jest.mock('../messaging', () => ({ getMessagingService: () => null }));

import { joinRequestProblem, JOIN_REQUEST_NOT_REMEMBERED } from '../groupControlOutcome';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');
}

function readCore(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

/** Тот же исходник без строк-комментариев: слово `profileKvSet` осталось в
 *  пояснении к правке, и искать его надо в коде, а не в рассказе о нём. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('отказ записи отметки не выдаётся за удачу', () => {
  const APP = read('App.tsx');

  it('отметка пишется проверяемой записью, а её ответ доходит до плашки', () => {
    expect(APP).toContain(
      'const remembered = await scopedKvSetCheckedFor(pid, INVITE_PENDING_KEY_PREFIX + payload.id, payload.adminPub);'
    );
  });

  it('прежней глухой записи в этом месте не осталось', () => {
    // Это было единственное обращение к глухой записи во всём App.tsx.
    expect(codeOnly(APP)).not.toContain('profileKvSet');
  });

  it('плашка выбирает слова по ответу записи, а не поверх него', () => {
    expect(APP).toContain(
      "?? (remembered ? 'Запрос на вступление отправлен администратору' : JOIN_REQUEST_NOT_REMEMBERED));"
    );
  });

  it('фраза называет расхождение, а не «ошибку записи»', () => {
    // Человеку важно одно: заявку могут принять, а группы он не увидит, — и
    // что с этим делать. Слова «база», «запись», «сохранить» ему не помогут.
    expect(JOIN_REQUEST_NOT_REMEMBERED).toContain('не запомнил');
    expect(JOIN_REQUEST_NOT_REMEMBERED).toContain('примет');
    expect(JOIN_REQUEST_NOT_REMEMBERED).toContain('Откройте ссылку ещё раз');
    expect(JOIN_REQUEST_NOT_REMEMBERED).not.toMatch(/ошибк|баз[аые]|сохран/i);
  });
});

describe('ГРАНИЦА: неушедшая заявка остаётся главной жалобой', () => {
  it('конверт не ушёл — говорим про заявку, отметка тут не при чём', () => {
    const said = joinRequestProblem({ sent: false, reason: 'no_service' });
    expect(said).not.toBeNull();
    expect(said).not.toBe(JOIN_REQUEST_NOT_REMEMBERED);
  });

  it('некому отправлять — своя отдельная фраза', () => {
    expect(joinRequestProblem({ sent: false, reason: 'no_peer' })).toContain('в ссылке нет администратора');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: удачный путь молчит, как и раньше', () => {
  it('заявка ушла — жалобы нет', () => {
    expect(joinRequestProblem({ sent: true, recipients: 1, of: 1 })).toBeNull();
  });

  it('разбираемое место в App.tsx — то самое: заявка по ссылке с одобрением', () => {
    const APP = read('App.tsx');
    expect(APP).toContain(
      'const asked = await sendGroupJoinRequest(payload.id, safeName, payload.adminPub, myPub, displayName, undefined, payload.token);'
    );
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('profileKvSet по-прежнему проглатывает отказ: ответа у него нет', () => {
    const local = readCore('storage/local.ts');
    expect(local).toContain(
      'export async function profileKvSet(profileId: number, key: string, value: string): Promise<void> {'
    );
  });

  it('проверяемая пара отвечает, легла ли запись', () => {
    const scoped = readCore('storage/profileScopedKv.ts');
    expect(scoped).toContain(
      'export async function scopedKvSetCheckedFor(pid: number, key: string, value: string): Promise<boolean> {'
    );
    expect(scoped).toContain('  return written;');
  });

  it('отметка по-прежнему то единственное, что пускает приглашение', () => {
    const gm = readCore('social/groupMessaging.ts');
    expect(gm).toContain('const pending = await scopedKvTryGetFor(rcpt.pid, INVITE_PENDING_KEY_PREFIX + groupId);');
    expect(gm).toContain("else if (pending.value === senderPubB64) return 'yes';");
  });
});
