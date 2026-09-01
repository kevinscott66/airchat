import React, { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from './AppPressable';
import { StatusBanner } from './StatusBanner';
import { subscribeStoragePressure } from '../../core/storage/local';
import {
  NO_PRESSURE,
  onPressureDismiss,
  onPressureEvent,
  type PressureState,
} from '../../core/storage/storagePressure';

/**
 * Предупреждение «на устройстве кончилось место» (v4.32.300).
 *
 * Наблюдатель за переполнением базы существовал с v4.32.126, но подписчика у
 * него не было ни одного — то есть человек по-прежнему не узнавал о том, что
 * запись не удалась. А не удаётся она молча: сохранение сообщения ошибку не
 * бросает, поэтому отправленное рисуется в переписке и пропадает при следующем
 * её открытии. Здесь и появляется единственное место, где об этом говорится
 * вслух.
 *
 * Показывается рядом с очередью отправки — над содержимым, на всех экранах:
 * место кончается не в настройках, а посреди переписки.
 *
 * v4.32.385: заливка '#2a1818' и текст '#ffb4b4' были вписаны руками, то есть
 * полоска существовала только в тёмной теме. Теперь общая полоска состояния.
 */
export function StoragePressureBanner(): React.ReactElement | null {
  const [state, setState] = useState<PressureState>(NO_PRESSURE);

  useEffect(() => {
    return subscribeStoragePressure((kind) => {
      setState((prev) => onPressureEvent(prev, kind, Date.now()));
    });
  }, []);

  if (!state.shown) return null;

  const diskFull = state.shown === 'disk_full';
  return (
    <StatusBanner
      tone="error"
      icon={diskFull ? 'save-outline' : 'warning-outline'}
      liveRegion="assertive"
      text={diskFull
        ? 'На устройстве закончилось место — новые сообщения не сохраняются. Освободите место, иначе переписка будет теряться.'
        : 'Не удаётся записать данные на устройство. Проверьте свободное место: часть сообщений может не сохраниться.'}
      trailing={(ink) => (
        <AppPressable
          onPress={() => setState((prev) => onPressureDismiss(prev, Date.now()))}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Скрыть предупреждение о нехватке места"
        >
          <Ionicons name="close" size={16} color={ink} />
        </AppPressable>
      )}
    />
  );
}
