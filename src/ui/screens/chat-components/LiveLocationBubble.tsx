import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from '../../components/AppPressable';
import { openMapAt } from '../../utils/openExternal';
import { useTheme } from '../../ThemeContext';
import { contrastingInk } from '../../theme';
import { useBubbleSurface } from '../../BubbleKindContext';
import { liveLocDetail, liveLocState, liveLocTitle } from '../../../core/social/liveLocFreshness';

/**
 * Пузырь живой геолокации. Один и тот же и в переписке, и в группе:
 * v4.32.563 экран групп рисовал свою копию, отставшую на несколько правок —
 * без таймера перерисовки (плашка LIVE не гасла сама никогда) и без строки
 * «ещё N мин».
 *
 * Состояние считает liveLocFreshness: срока окончания мало, потому что
 * рассылка обрывается вместе с процессом приложения, никому об этом не
 * сообщая. Подробности — в докблоке того модуля.
 */
export function LiveLocationBubble({ text, isOutgoing }: { text: string; isOutgoing: boolean }): React.ReactElement | null {
  const { colors } = useTheme();
  // v4.32.411: подписи внутри пузыря — от его заливки, а не от палитры.
  const bubble = useBubbleSurface(isOutgoing);
  const { parseLiveLoc } = require('../../../core/social/liveLocationService') as typeof import('../../../core/social/liveLocationService');
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const meta = parseLiveLoc(text, now);
  const textColor = bubble.ink.text;
  const mutedColor = bubble.ink.secondary;
  // v4.32.563: неразобранный конверт давал пустой пузырь — прямоугольник без
  // единого слова, по которому нельзя понять, что вообще пришло. Молчание
  // здесь тоже сообщение, и оно должно быть написано.
  if (!meta) {
    return (
      <Text style={{ color: mutedColor, fontSize: 13 }}>Живая геолокация недоступна</Text>
    );
  }
  const state = liveLocState({ expireAt: meta.expireAt, now, updatedAt: meta.ts });
  const live = state === 'live';
  const detail = liveLocDetail({ expireAt: meta.expireAt, now, updatedAt: meta.ts });
  const coords = `${meta.lat.toFixed(5)}, ${meta.lon.toFixed(5)}`;
  return (
    <AppPressable
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 200, paddingVertical: 2 }}
      onPress={() => openMapAt(meta.lat, meta.lon)}
    >
      {/* v4.32.388: значок — графика (порог 3:1), поэтому colors.success;
          плашка LIVE несёт белую надпись, то есть заливка — successFill. */}
      <View style={{ position: 'relative' }}>
        <Ionicons name="location" size={28} color={live ? bubble.ink.success : mutedColor} />
        {live && (
          <View style={{ position: 'absolute', top: -2, right: -4, backgroundColor: colors.successFill, borderRadius: 5, paddingHorizontal: 3, paddingVertical: 1 }}>
            <Text style={{ color: contrastingInk(colors.successFill), fontSize: 8, fontWeight: '700' }}>LIVE</Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: textColor, fontWeight: '600', fontSize: 13 }}>{liveLocTitle(state)}</Text>
        <Text style={{ color: mutedColor, fontSize: 11 }}>{detail ? `${coords} · ${detail}` : coords}</Text>
      </View>
      {state !== 'ended' && <Ionicons name="open-outline" size={16} color={mutedColor} />}
    </AppPressable>
  );
}
