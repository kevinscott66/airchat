import React from 'react';
import { StatusBanner } from './StatusBanner';
import type { AirChatVpnUiStatus } from '../../core/vpn/airChatVpnController';

type Props = { status: AirChatVpnUiStatus; onRetry?: () => void };

/**
 * Состояние встроенного защищённого канала.
 *
 * v4.32.385: у полоски была своя палитра из шести значений ('#1a2238',
 * '#142318', '#2a1818', '#9aa3c0', '#8fd99a', '#ffb4b4') и своя геометрия —
 * третья копия одного и того же элемента. Тему она не спрашивала, то есть в
 * светлой теме показывала тёмные плашки поверх белого фона. Осталось только
 * назначение: нейтрально / хорошо / плохо.
 */
export function VpnStatusBanner({ status, onRetry }: Props): React.ReactElement | null {
  if (status === 'off') return null;

  if (status === 'unsupported') {
    return (
      <StatusBanner tone="neutral" icon="information-circle-outline" text="Встроенный канал: только Android" />
    );
  }

  if (status === 'starting') {
    return (
      <StatusBanner tone="neutral" icon="sync-outline" text="Подключение защищённого канала…" />
    );
  }

  if (status === 'failed') {
    return (
      <StatusBanner
        tone="error"
        icon="warning-outline"
        text="Защищённое соединение не включено. Прямое подключение (ограниченная работа). Нажмите для повтора."
        onPress={onRetry}
        accessibilityLabel="Повторить подключение защищённого канала"
      />
    );
  }

  return (
    <StatusBanner tone="ok" icon="shield-checkmark" text="Защищённое соединение активно" />
  );
}
