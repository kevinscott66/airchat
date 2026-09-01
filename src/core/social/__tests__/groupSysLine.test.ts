import {
  GROUP_SYS_PREFIX,
  isGroupSysMessage,
  makeGroupSysText,
  parseGroupSysText,
} from '../groupSysLine';
import { SYS_LINE_PREFIX, stripSpoofedSysPrefix } from '../sysLineGuard';

describe('groupSysLine', () => {
  it('префикс отрисовки и префикс защиты — одно и то же значение', () => {
    // Ради этого модуль и заведён: если они разойдутся, экран продолжит
    // рисовать серым по центру то, что stripSpoofedSysPrefix уже не узнаёт.
    expect(GROUP_SYS_PREFIX).toBe(SYS_LINE_PREFIX);
  });

  it('makeGroupSysText / parseGroupSysText — обратимы', () => {
    const event = 'Группа переименована в «Дача»';
    const line = makeGroupSysText(event);
    expect(isGroupSysMessage(line)).toBe(true);
    expect(parseGroupSysText(line)).toBe(event);
  });

  it('обычный текст системной строкой не считается', () => {
    expect(isGroupSysMessage('привет')).toBe(false);
    expect(isGroupSysMessage('sys: привет')).toBe(false);
    expect(isGroupSysMessage('')).toBe(false);
  });

  it('строка, пришедшая по сети, теряет системный вид', () => {
    // Собеседник шлёт готовую системную строку — защита обязана её распознать
    // именно потому, что префикс общий.
    const spoofed = makeGroupSysText('Вы заблокированы в группе');
    expect(isGroupSysMessage(stripSpoofedSysPrefix(spoofed))).toBe(false);
  });

  it('событие с пустым текстом остаётся системной строкой', () => {
    expect(isGroupSysMessage(makeGroupSysText(''))).toBe(true);
    expect(parseGroupSysText(makeGroupSysText(''))).toBe('');
  });
});
