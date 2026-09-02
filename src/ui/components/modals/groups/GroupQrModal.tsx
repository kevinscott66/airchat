import React, { memo, useCallback } from 'react';
import { View, Text, Clipboard } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { AppModal as Modal } from '../../AppModal';
import { AppPressable } from '../../AppPressable';
import { useTheme } from '../../../ThemeContext';
import { useDeferredMount } from '../../../../core/hooks/useDeferredMount';
import { showSuccess } from '../../userFeedback';
import { primaryInk, QR_CODE, radius, scrim } from '../../../theme';
import { COPIED_LINK, COPY_LINK_ACTION } from '../../../clipboardText';

export interface GroupQrModalProps {
  visible: boolean;
  onClose: () => void;
  groupName: string;
  inviteLinkQr: string;
}

function GroupQrModalImpl({ visible, onClose, groupName, inviteLinkQr }: GroupQrModalProps) {
  const mounted = useDeferredMount(visible);
  const { colors } = useTheme();
  const stopPropagation = useCallback(() => { /* prevent dismiss */ }, []);
  const handleCopy = useCallback(() => {
    Clipboard.setString(inviteLinkQr);
    showSuccess(COPIED_LINK);
    onClose();
  }, [inviteLinkQr, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <AppPressable style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: scrim.modal }} onPress={onClose}>
        <AppPressable style={{ backgroundColor: colors.surface, borderRadius: radius.xl, padding: 28, alignItems: 'center', gap: 16, width: 280 }} onPress={stopPropagation}>
          {mounted ? (
            <>
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>{groupName}</Text>
              <View style={{ padding: QR_CODE.quietZone, backgroundColor: QR_CODE.fill, borderRadius: radius.lg }}>
                <QRCode value={inviteLinkQr} size={180} color={QR_CODE.ink} backgroundColor={QR_CODE.fill} />
              </View>
              <Text style={{ fontSize: 12, color: colors.textMuted, textAlign: 'center' }}>Отсканируйте для вступления в группу</Text>
              <AppPressable
                style={{ paddingHorizontal: 24, paddingVertical: 10, backgroundColor: colors.primary, borderRadius: radius.md }}
                onPress={handleCopy}
              >
                <Text style={{ color: primaryInk(colors).text, fontWeight: '600' }}>{COPY_LINK_ACTION}</Text>
              </AppPressable>
            </>
          ) : null}
        </AppPressable>
      </AppPressable>
    </Modal>
  );
}

export const GroupQrModal = memo(GroupQrModalImpl);
