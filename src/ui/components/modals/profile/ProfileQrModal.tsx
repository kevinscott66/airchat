/**
 * ProfileQrModal — карточка человека в виде кода (v4.32.573).
 *
 * Строка DID под кнопкой «копировать» и кнопкой «поделиться» закрывала один
 * способ передать контакт и не закрывала второй. «Скопировать» и «поделиться»
 * работают, когда есть куда отправить: мессенджер, почта, заметка. А когда
 * второй телефон просто рядом — в руках у человека напротив, — отправлять
 * некуда, и остаётся диктовать вслух строку из полусотни символов.
 *
 * Код закрывает именно этот случай: его показывают, а не пересылают. Это тот
 * же самый DID, ничего дополнительного в нём не зашито, — камера читает ровно
 * ту строку, которую даёт кнопка «копировать». Поэтому здесь нет ни ссылки на
 * сервер, ни короткого адреса, который надо где-то разворачивать: код
 * работает без сети, как и всё остальное в этом окне.
 */
import React, { memo, useCallback } from 'react';
import { View, Text } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { font, QR_CODE, radius, scrim, spacing } from '../../../theme';

export interface ProfileQrModalProps {
  visible: boolean;
  onClose: () => void;
  /** Чей код — имя показывается над кодом, чтобы не перепутать два открытых. */
  title: string;
  /** Что закодировано. Ровно то, что даёт кнопка «копировать». */
  value: string;
}

function ProfileQrModalImpl({ visible, onClose, title, value }: ProfileQrModalProps) {
  // Код рисуется не мгновенно, а окно открывается поверх уже открытого
  // профиля: без отложенной сборки анимация появления заметно спотыкается.
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  const stop = useCallback(() => { /* тап по карточке не закрывает окно */ }, []);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} testID="profile_qr_modal">
      <AppPressable
        style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: scrim.modal }}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Закрыть"
      >
        <AppPressable
          style={{
            backgroundColor: colors.surface,
            borderRadius: radius.xl,
            padding: spacing.lg,
            alignItems: 'center',
            gap: spacing.md,
            width: 280,
          }}
          onPress={stop}
        >
          {mounted ? (
            <>
              <Text
                style={{ fontSize: font.md, fontWeight: '700', color: colors.text, textAlign: 'center' }}
                numberOfLines={2}
              >
                {title}
              </Text>
              {/* Тихая зона и белая подложка — не оформление: код читается
                  камерой только при светлом фоне вокруг модулей, и в тёмной
                  теме подложка обязана остаться светлой. */}
              <View style={{ padding: QR_CODE.quietZone, backgroundColor: QR_CODE.fill, borderRadius: radius.lg }}>
                <QRCode value={value} size={200} color={QR_CODE.ink} backgroundColor={QR_CODE.fill} />
              </View>
              <Text style={{ fontSize: font.xs, color: colors.textMuted, textAlign: 'center' }}>
                Наведите камеру, чтобы добавить контакт
              </Text>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

export const ProfileQrModal = memo(ProfileQrModalImpl);
export default ProfileQrModal;
