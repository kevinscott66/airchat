/**
 * Сбой чтения переписки группы — не пустая группа (v4.32.532).
 *
 * `listGroupMessages` ловила любое исключение и возвращала пустой массив.
 * Экран трактовал это как факт: гасил подгрузку, рисовал «Нет сообщений» и
 * следом отмечал группу прочитанной — счётчик непрочитанного обнулялся из-за
 * секундной блокировки базы, и вернуть его было нечем. Экспорт на той же
 * механике мог выгрузить первые пятьсот сообщений из тысячи и выглядеть
 * полным файлом.
 *
 * Правило про три исхода чтения живёт в `core/storage/readResult`; здесь
 * рэтчет на то, что группы им пользуются, а не заводят четвёртую копию.
 */
import fs from 'fs';
import path from 'path';

const LOCAL = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'core', 'storage', 'local.ts'), 'utf8');
const SCREEN = fs.readFileSync(path.join(__dirname, '..', 'GroupsScreen.tsx'), 'utf8');
const MODAL = fs.readFileSync(path.join(
  __dirname, '..', '..', 'components', 'modals', 'groups', 'GroupSharedMediaModal.tsx'), 'utf8');

/** Тело одной экспортируемой функции из очень большого файла. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + 10);
  const end = rest.indexOf('\nexport ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('чтение переписки группы различает пустоту и сбой', () => {
  it('listGroupMessages отдаёт null вместо пустого списка', () => {
    const body = fnBody(LOCAL, 'listGroupMessages');
    expect(body).toContain('Promise<DbRead<GroupMessageRow>>');
    expect(body).toContain('list_group_messages_failed');
    expect(body).toContain('return null;');
    expect(body).not.toContain('return [];');
  });

  it('постраничное чтение всей переписки обрывается на первом сбое', () => {
    const body = fnBody(LOCAL, 'listAllGroupMessages');
    expect(body).toContain('Promise<DbRead<GroupMessageRow>>');
    expect(body).toContain('if (page === null) return null;');
    // Усечённая выгрузка выглядит полной — «сколько прочиталось» здесь не ответ.
    expect(body).not.toContain('if (page === null) break;');
  });

  it('медиа группы тоже отдают null', () => {
    const body = fnBody(LOCAL, 'listGroupConversationMedia');
    // v4.32.584: тип строки получил имя — в нём появился признак
    // непрочитанной ячейки (см. core/media/sharedMediaScan).
    expect(body).toContain('Promise<DbRead<SharedMediaRow>>');
    expect(body).toContain('list_group_conversation_media_failed');
    expect(body).toContain('return null;');
  });

  it('local.ts берёт тип у общего правила, а не объявляет свой', () => {
    expect(LOCAL).toContain("import type { DbRead } from './readResult';");
  });
});

describe('GroupsScreen не выдаёт сбой за пустую группу', () => {
  it('экран пользуется общим правилом', () => {
    expect(SCREEN).toContain("from '../../core/storage/readResult'");
  });

  it('сбой чтения не доходит ни до списка, ни до отметки о прочтении', () => {
    const guard = SCREEN.indexOf('if (!shouldApplyRows(read))');
    // v4.32.533: список теперь склеивается с сохранённым хвостом — см.
    // listHeadMerge.test.ts; проверка порядка от этого не меняется.
    const list = SCREEN.indexOf('setMessages(merged);');
    const read = SCREEN.indexOf('await markGroupRead(group.id, pid);');
    const receipts = SCREEN.indexOf('void sendGroupReadReceipt(');
    expect(guard).toBeGreaterThan(-1);
    // Порядок здесь и есть суть правки: всё перечисленное оправдано только
    // тем, что чтение удалось.
    expect(list).toBeGreaterThan(guard);
    expect(read).toBeGreaterThan(guard);
    expect(receipts).toBeGreaterThan(guard);
    expect(SCREEN).toContain('ui_group_load_messages_read_failed');
    expect(SCREEN).toContain('setMsgReadFailed(true)');
    expect(SCREEN).toContain('setMsgReadFailed(false)');
  });

  it('подгрузка не гасит «есть ещё» из-за сбоя', () => {
    expect(SCREEN).toContain('decidePage(page, PAGE_SIZE)');
    expect(SCREEN).toContain('if (decision.endOfList) setHasMore(false);');
    expect(SCREEN).toContain('ui_group_load_more_read_failed');
    expect(SCREEN).not.toContain('setHasMore(more.length === PAGE_SIZE);');
    expect(SCREEN).not.toContain('if (more.length > 0) {');
  });

  it('пустое состояние отличает сбой от пустой группы', () => {
    expect(SCREEN).toContain('msgReadFailed');
    expect(SCREEN).toContain("'Не удалось открыть переписку'");
    // Обещать то, чего в экране нет: тянуть список вниз тут нечем —
    // RefreshControl у переписки группы не заведён.
    expect(SCREEN.includes('RefreshControl')).toBe(false);
    expect(SCREEN).not.toContain('Потяните список вниз');
  });

  it('журнал администратора и экспорт проверяют исход', () => {
    expect(SCREEN).toContain("showError('Не удалось прочитать журнал группы')");
    expect(SCREEN).toContain("showError('Не удалось прочитать переписку для экспорта')");
    const exportGuard = SCREEN.indexOf('if (!shouldApplyRows(allMsgs))');
    const sort = SCREEN.indexOf('const sorted = [...allMsgs]');
    expect(exportGuard).toBeGreaterThan(-1);
    expect(sort).toBeGreaterThan(exportGuard);
  });
});

describe('окно общих медиа группы', () => {
  it('обе выборки различают пустоту и сбой', () => {
    expect(MODAL).toContain("from '../../../../core/storage/readResult'");
    expect(MODAL).toContain('setReadFailed(true)');
    expect(MODAL).toContain('setReadFailed(false)');
    expect(MODAL).not.toContain('.then(setItems)');
    // Оба чтения обязаны довести ошибку до экрана.
    const handled = MODAL.split('.catch(() => { if (alive) setReadFailed(true); });').length - 1;
    expect(handled).toBe(2);
    // Молчаливых перехватов здесь больше нет. Последний — открытие внешней
    // ссылки — жил тут до v4.32.535: тогда его чинили не поштучно, а разом
    // во всех тринадцати местах, общей дверью `ui/utils/openExternal`.
    const silent = MODAL.split('.catch(() => {})').length - 1;
    expect(silent).toBe(0);
    expect(MODAL).toContain("openExternal(link.url, 'group_shared_link')");
  });

  it('ответ прошлого открытия не дописывается в закрытое окно', () => {
    expect(MODAL).toContain('let alive = true;');
    expect(MODAL).toContain('return () => { alive = false; };');
    expect(MODAL).toContain('if (!alive) return;');
  });

  it('текст про сбой один на три вкладки', () => {
    expect(MODAL).toContain("const GSM_READ_FAILED = 'Не удалось прочитать переписку';");
    const uses = MODAL.split('GSM_READ_FAILED').length - 1;
    expect(uses).toBeGreaterThanOrEqual(4);
  });
});
