import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from '../../AppPressable';
import { SheetShell } from '../../SheetShell';
import { useTheme } from '../../../ThemeContext';
import { contrastingInk, font, radius } from '../../../theme';
import { WALLPAPER_MESHES, WALLPAPER_PRESETS, type Wallpaper } from '../../../wallpapers';
import { WallpaperBackground } from '../../WallpaperBackground';
import { chatBgKey } from '../../../../core/storage/kvKeys';
import { scopedKvSet } from '../../../../core/storage/profileScopedKv';

// ─── Wallpaper Picker Modal ───────────────────────────────────────────────────
export function WallpaperPickerModal({
  visible,
  peerB64,
  current,
  onClose,
  onApply,
}: {
  visible: boolean;
  peerB64: string;
  current: Wallpaper | null;
  onClose: () => void;
  onApply: (wp: Wallpaper | null) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const save = async (wp: Wallpaper | null) => {
    // v4.32.487: фон — решение аккаунта, а не телефона: собеседник у двух
    // профилей может быть один и тот же.
    await scopedKvSet(chatBgKey(peerB64), wp ? JSON.stringify(wp) : '');
    onApply(wp);
    onClose();
  };
  return (
    <SheetShell visible={visible} onClose={onClose}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17, marginBottom: 16, textAlign: 'center' }}>Фон чата</Text>
          {/* v4.32.533: градиенты идут первыми — это единственный ряд, в
              котором образцы отличаются друг от друга на глаз. Образец
              рисуется тем же компонентом, что и сам фон, поэтому «как в
              наборе» и «как в чате» не могут разойтись. */}
          <Text style={{ color: colors.textSecondary, fontSize: font.xs, marginBottom: 8 }}>Градиенты</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginBottom: 16 }}>
            {WALLPAPER_MESHES.map((m) => {
              const picked = current?.type === 'mesh' && current.value === m.id;
              return (
                <AppPressable
                  key={m.id}
                  onPress={() => void save({ type: 'mesh', value: m.id })}
                  accessibilityRole="button"
                  accessibilityLabel={m.label}
                  accessibilityState={{ selected: picked }}
                  style={{
                    width: 52, height: 52, borderRadius: radius.lg, overflow: 'hidden',
                    borderWidth: picked ? 3 : 1,
                    borderColor: picked ? colors.primary : 'transparent',
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <WallpaperBackground wallpaper={{ type: 'mesh', value: m.id }} ground={m.base} />
                  {picked ? <Ionicons name="checkmark" size={18} color={contrastingInk(m.ground)} /> : null}
                </AppPressable>
              );
            })}
          </View>
          <Text style={{ color: colors.textSecondary, fontSize: font.xs, marginBottom: 8 }}>Однотонные</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginBottom: 16 }}>
            {WALLPAPER_PRESETS.map((p) => {
              const picked = p.value === null
                ? current === null
                : current?.type === 'color' && current.value === p.value;
              return (
                <AppPressable
                  key={p.label}
                  onPress={() => void save(p.value ? { type: 'color', value: p.value } : null)}
                  // Квадрат без подписи: вслух его называет только это.
                  accessibilityRole="button"
                  accessibilityLabel={p.label}
                  accessibilityState={{ selected: picked }}
                  style={{
                    width: 52, height: 52, borderRadius: radius.lg,
                    backgroundColor: p.value ?? colors.surfaceHigh,
                    borderWidth: p.value === null ? 1 : (picked ? 3 : 1),
                    borderColor: p.value === null ? colors.border : (picked ? colors.primary : 'transparent'),
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {p.value === null ? <Text style={{ color: colors.textMuted, fontSize: font.xs }}>Нет</Text> : null}
                  {/* v4.32.410: галочка была белой при любом образце. Половина
                      набора теперь светлая — цвет считается от самого образца. */}
                  {picked && p.value ? <Ionicons name="checkmark" size={18} color={contrastingInk(p.value)} /> : null}
                </AppPressable>
              );
            })}
          </View>
          <AppPressable
            onPress={() => {
              void (async () => {
                const ip = await import('expo-image-picker');
                // v4.32.54: quality:1 + exif:false — избегает NoSuchMethodError CompressionImageExporter.
                const res = await ip.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false });
                if (!res.canceled && res.assets[0]?.uri) {
                  // v4.32.410: снимок сохранялся как `type: 'color'`, и экран
                  // потом подставлял путь к файлу в `backgroundColor` — то есть
                  // «Выбрать фото из галереи» не работало вовсе. Тип у снимка
                  // свой, и рисуется он картинкой.
                  await save({ type: 'image', value: res.assets[0].uri });
                }
              })();
            }}
            accessibilityRole="button"
            style={{ backgroundColor: colors.surfaceHigh, borderRadius: radius.lg, paddingVertical: 14, alignItems: 'center', marginBottom: 10 }}
          >
            <Text style={{ color: colors.text, fontSize: 15 }}>Выбрать фото из галереи</Text>
          </AppPressable>
    </SheetShell>
  );
}
