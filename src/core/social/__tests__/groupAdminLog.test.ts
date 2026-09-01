import { adminLogEvent } from '../groupAdminLog';
import { roleChangeSysText } from '../groupRolePolicy';
import { slowModeSysLine } from '../groupSendPolicy';

/**
 * v4.32.390. Словарь событий журнала. Строки, которые собираются функциями,
 * берутся из этих функций, а не переписываются сюда: иначе тест перестанет
 * ловить расхождение ровно тогда, когда формулировка поменяется.
 */
describe('adminLogEvent', () => {
  describe('роли', () => {
    it('назначение администратором — щит с галочкой', () => {
      expect(adminLogEvent(roleChangeSysText('admin', 'member', 'Аня', false)))
        .toEqual({ icon: 'shield-checkmark-outline', tone: 'primary' });
    });

    it('«ограничение снято, назначен(а) администратором» — назначение, а не ограничение', () => {
      const line = roleChangeSysText('admin', 'restricted', 'Аня', false);
      expect(line).toContain('ограничение снято');
      expect(adminLogEvent(line)).toEqual({ icon: 'shield-checkmark-outline', tone: 'primary' });
    });

    it('разжалование — щит без галочки, а не значок назначения', () => {
      expect(adminLogEvent(roleChangeSysText('member', 'admin', 'Аня', false)))
        .toEqual({ icon: 'shield-outline', tone: 'warning' });
    });

    it('разжалование с ограничением — запрет, а не назначение', () => {
      // Ровно этот случай лестница показывала значком «назначен администратором»:
      // строка содержит слово «администраторов», и первое же правило её ловило.
      const line = roleChangeSysText('restricted', 'admin', 'Аня', false);
      expect(line).toContain('администраторов');
      expect(adminLogEvent(line)).toEqual({ icon: 'ban-outline', tone: 'warning' });
    });

    it('ограничение отправки — запрет', () => {
      expect(adminLogEvent(roleChangeSysText('restricted', 'member', 'Аня', false)))
        .toEqual({ icon: 'ban-outline', tone: 'warning' });
    });

    it('снятие ограничения — снова может писать', () => {
      expect(adminLogEvent(roleChangeSysText('member', 'restricted', 'Аня', false)))
        .toEqual({ icon: 'chatbubble-outline', tone: 'success' });
    });
  });

  describe('состав группы', () => {
    it.each([
      ['Аня исключён(а) из группы', 'person-remove-outline', 'error'],
      ['Аня заблокирован(а) в группе', 'ban-outline', 'error'],
      ['Аня разблокирован(а)', 'person-add-outline', 'success'],
      ['Аня вступил(а) в группу', 'person-add-outline', 'success'],
      ['Аня создал(а) группу «Двор»', 'star-outline', 'star'],
    ])('%s', (text, icon, tone) => {
      expect(adminLogEvent(text)).toEqual({ icon, tone });
    });

    it('разблокировка не читается как блокировка', () => {
      expect(adminLogEvent('Аня разблокирован(а)').tone).not.toBe(adminLogEvent('Аня заблокирован(а) в группе').tone);
    });
  });

  describe('настройки группы', () => {
    it.each([
      ['Группа переименована в «Двор»', 'pencil-outline', 'primary'],
      ['Аватар группы обновлён', 'image-outline', 'primary'],
      ['Сообщение закреплено', 'pin-outline', 'accent'],
      ['Сообщение откреплено', 'pin-outline', 'accent'],
      ['Закреплять сообщения могут только администраторы', 'pin-outline', 'accent'],
      ['Закреплять сообщения могут все участники', 'pin-outline', 'accent'],
      ['Режим «только для администраторов» включён', 'lock-closed-outline', 'warning'],
      ['Режим «только для администраторов» выключен', 'lock-closed-outline', 'warning'],
      ['Исчезающие сообщения включены: 24 ч', 'flame-outline', 'textSecondary'],
      ['Исчезающие сообщения выключены', 'flame-outline', 'textSecondary'],
      ['Пригласительная ссылка сброшена: прежние больше не действуют', 'link-outline', 'warning'],
      ['Вход по ссылке теперь требует одобрения', 'link-outline', 'primary'],
      ['Вход по ссылке без одобрения', 'link-outline', 'primary'],
      ['Имена отправителей скрыты', 'eye-off-outline', 'textSecondary'],
      ['Имена отправителей видны', 'eye-off-outline', 'textSecondary'],
    ])('%s', (text, icon, tone) => {
      expect(adminLogEvent(text)).toEqual({ icon, tone });
    });

    it.each([0, 30, 3600])('медленный режим (%s c) — таймер', (secs) => {
      expect(adminLogEvent(slowModeSysLine(secs)))
        .toEqual({ icon: 'timer-outline', tone: 'textSecondary' });
    });

    it('«закреплять могут только администраторы» — про закрепление, а не про режим админов', () => {
      // Строка содержит и «Закреплять сообщения», и «только … администраторы».
      expect(adminLogEvent('Закреплять сообщения могут только администраторы').icon).toBe('pin-outline');
    });
  });

  it('неизвестное событие — общий значок, а не пустой цвет', () => {
    expect(adminLogEvent('Что-то, чего ещё нет в словаре'))
      .toEqual({ icon: 'information-circle-outline', tone: 'textMuted' });
  });
});
