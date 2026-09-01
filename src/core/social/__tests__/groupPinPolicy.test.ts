/**
 * Право закрепления сообщения в группе.
 *
 * Функция одна и та же на отправке (GroupsScreen → togglePinAndSync) и на
 * приёме конверта ('\x0egctl:' op:'pin'). Расхождение между этими двумя
 * сторонами означало бы, что закрепление проходит у автора и молча
 * отбрасывается у всех остальных — то есть ровно тот баг, ради которого
 * рассылка и появилась. Поэтому политика вынесена в модуль без импортов и
 * закреплена тестами.
 */

import { canPinInGroup, type PinRole } from '../groupPinPolicy';

const ROLES: PinRole[] = ['owner', 'admin', 'member', 'restricted', 'banned'];

describe('canPinInGroup', () => {
  it('владелец и админ закрепляют при любой настройке', () => {
    for (const role of ['owner', 'admin'] as PinRole[]) {
      for (const adminOnlyPinning of [true, false]) {
        expect(canPinInGroup({ role, adminOnlyPinning })).toBe(true);
        expect(canPinInGroup({ role, adminOnlyPinning, type: 'channel' })).toBe(true);
        expect(canPinInGroup({ role, adminOnlyPinning, type: 'supergroup' })).toBe(true);
      }
    }
  });

  it('забаненному нельзя ничего и никогда', () => {
    for (const adminOnlyPinning of [true, false]) {
      for (const type of ['group', 'channel', 'supergroup'] as const) {
        expect(canPinInGroup({ role: 'banned', adminOnlyPinning, type })).toBe(false);
      }
    }
  });

  it('обычный участник следует настройке группы', () => {
    expect(canPinInGroup({ role: 'member', adminOnlyPinning: true })).toBe(false);
    expect(canPinInGroup({ role: 'member', adminOnlyPinning: false })).toBe(true);
    expect(canPinInGroup({ role: 'member', adminOnlyPinning: false, type: 'supergroup' })).toBe(true);
  });

  it('в канале не-админ не закрепляет даже при выключенной настройке', () => {
    // Писать в канал может только администрация; закрепление подписчиком было
    // бы единственным способом показать что-то всей аудитории.
    expect(canPinInGroup({ role: 'member', adminOnlyPinning: false, type: 'channel' })).toBe(false);
    expect(canPinInGroup({ role: 'restricted', adminOnlyPinning: false, type: 'channel' })).toBe(false);
  });

  it('ограниченному участнику нельзя: баннер виден всем, как и сообщение', () => {
    expect(canPinInGroup({ role: 'restricted', adminOnlyPinning: false })).toBe(false);
    expect(canPinInGroup({ role: 'restricted', adminOnlyPinning: true })).toBe(false);
  });

  it('по умолчанию тип — обычная группа', () => {
    for (const role of ROLES) {
      expect(canPinInGroup({ role, adminOnlyPinning: false })).toBe(
        canPinInGroup({ role, adminOnlyPinning: false, type: 'group' })
      );
    }
  });

  it('adminOnlyPinning=true воспроизводит поведение до появления настройки', () => {
    // До 4.32.233 пункт «Закрепить» показывался ровно при amAdmin; DEFAULT 1 в
    // миграции обязан давать тот же результат для уже существующих групп.
    for (const role of ROLES) {
      const isAdminish = role === 'owner' || role === 'admin';
      expect(canPinInGroup({ role, adminOnlyPinning: true })).toBe(isAdminish);
    }
  });
});
