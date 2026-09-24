// Меню сообщения: состав и порядок пунктов.
//
// Правка v4.32.578 переставляет четырнадцать пунктов в «шесть на виду + Ещё».
// Эти тесты держат её честной: перестановка не имеет права ничего потерять,
// продублировать или превысить обещанный лимит.
import {
  MESSAGE_MENU_PRIMARY_MAX,
  messageMenu,
  type MessageMenuAction,
  type MessageMenuFlags,
} from '../messageMenuModel';

/** Все тридцать два сочетания флагов (v4.32.872: пятый — машинное тело). */
const ALL_FLAGS: MessageMenuFlags[] = [];
for (const isOut of [false, true]) {
  for (const isMedia of [false, true]) {
    for (const isMachineText of [false, true]) {
      for (const copyBlocked of [false, true]) {
        for (const canClosePoll of [false, true]) {
          ALL_FLAGS.push({ isOut, isMedia, isMachineText, copyBlocked, canClosePoll });
        }
      }
    }
  }
}

/**
 * Состав меню до правки — независимая копия условий из ChatQuickReactModal
 * версии 4.32.577. Специально записан отдельно, а не выведен из messageMenu:
 * иначе тест сверял бы функцию сама с собой.
 *
 * v4.32.872: сюда же перенесены три новых условия — копировать, переводить и
 * править машинное тело меню больше не предлагает. Копия остаётся
 * независимой: условия записаны своими словами, а не вызовом модели.
 */
function legacyActions(f: MessageMenuFlags): MessageMenuAction[] {
  const canCopy = !f.isMedia && !f.isMachineText && !f.copyBlocked;
  const out: MessageMenuAction[] = ['reply'];
  if (canCopy) out.push('copy');
  // Пересылка машинного тела остаётся: конверт уезжает целиком, и опрос у
  // собеседника остаётся опросом.
  if (!f.isMedia && !f.copyBlocked) out.push('forward');
  if (f.isOut && !f.isMedia && !f.isMachineText) out.push('edit');
  if (!f.isMedia && !f.isMachineText) out.push('translate');
  out.push('copyLink', 'pin', 'star');
  if (!f.isOut) out.push('markUnread');
  out.push('info', 'remind', 'select');
  if (f.canClosePoll) out.push('closePoll');
  out.push('delete');
  return out;
}

describe('messageMenu', () => {
  it('не показывает сразу больше обещанного числа пунктов', () => {
    for (const f of ALL_FLAGS) {
      expect(messageMenu(f).primary.length).toBeLessThanOrEqual(MESSAGE_MENU_PRIMARY_MAX);
    }
  });

  it('ничего не теряет: primary + more = прежний набор', () => {
    for (const f of ALL_FLAGS) {
      const m = messageMenu(f);
      expect([...m.primary, ...m.more].sort()).toEqual([...legacyActions(f)].sort());
    }
  });

  it('не дублирует пункты', () => {
    for (const f of ALL_FLAGS) {
      const m = messageMenu(f);
      const all = [...m.primary, ...m.more];
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it('«Ответить» — первый пункт, «Удалить» — последний из видимых', () => {
    for (const f of ALL_FLAGS) {
      const m = messageMenu(f);
      expect(m.primary[0]).toBe('reply');
      expect(m.primary[m.primary.length - 1]).toBe('delete');
    }
  });

  it('удаление никогда не прячется за «Ещё»', () => {
    for (const f of ALL_FLAGS) {
      expect(messageMenu(f).more).not.toContain('delete');
    }
  });

  it('запрет копирования убирает «Копировать» и «Переслать» целиком', () => {
    for (const f of ALL_FLAGS.filter((x) => x.copyBlocked)) {
      const all = [...messageMenu(f).primary, ...messageMenu(f).more];
      expect(all).not.toContain('copy');
      expect(all).not.toContain('forward');
    }
  });

  it('у медиасообщения нет текстовых действий', () => {
    for (const f of ALL_FLAGS.filter((x) => x.isMedia)) {
      const all = [...messageMenu(f).primary, ...messageMenu(f).more];
      expect(all).not.toContain('copy');
      expect(all).not.toContain('edit');
      expect(all).not.toContain('translate');
    }
  });

  it('«Отметить непрочитанным» — только для входящих', () => {
    for (const f of ALL_FLAGS) {
      const all = [...messageMenu(f).primary, ...messageMenu(f).more];
      expect(all.includes('markUnread')).toBe(!f.isOut);
    }
  });
});
