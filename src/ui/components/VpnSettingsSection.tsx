/**
 * Секция настроек встроенного VPN (Xray / VLESS+Reality) для SettingsScreen.
 *
 * Бэкенд уже готов (airChatVpnController + нативный модуль airchat-vpn); здесь —
 * единственный отсутствовавший кусок: ввод данных своего сервера. Пользователь
 * может вставить готовую ссылку `vless://…` (она авто-разбирается в поля) либо
 * отредактировать поля вручную, сохранить (saveConfigOverride пишет в
 * Documents/airchat-config.json и обновляет кэш) и подключиться.
 *
 * Самодостаточный компонент: грузит конфиг сам, не трогает навигацию App.tsx.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppSwitch } from './AppSwitch';
import { contrastingInk } from '../theme';
import { useThemedStyles } from '../ThemeContext';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import { showError, showSuccess } from './userFeedback';
import { loadConfig, saveConfigOverride, getConfigSync, type AppConfig } from '../../core/config';
import {
  retryEmbeddedVpn,
  stopEmbeddedVpn,
  getEmbeddedVpnRunning,
  type AirChatVpnUiStatus,
} from '../../core/vpn/airChatVpnController';
import { parseVlessUrl } from '../../core/vpn/parseVlessUrl';

type VpnConfig = NonNullable<AppConfig['vpn']>;

const STATUS_LABEL: Record<AirChatVpnUiStatus, string> = {
  off: 'Отключён',
  starting: 'Подключение…',
  on: 'Подключён',
  failed: 'Ошибка подключения',
  unsupported: 'Недоступно на этом устройстве',
};

export function VpnSettingsSection(): React.ReactElement {
  const [link, setLink] = useState('');
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('443');
  const [uuid, setUuid] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [shortId, setShortId] = useState('');
  const [sni, setSni] = useState('');
  const [flow, setFlow] = useState('xtls-rprx-vision');
  const [fingerprint, setFingerprint] = useState('chrome');
  const [autoStart, setAutoStart] = useState(false);
  const [status, setStatus] = useState<AirChatVpnUiStatus>('off');

  // Префилл из текущего конфига при монтировании.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const cfg = await loadConfig();
      const v = cfg.vpn;
      if (!alive || !v) return;
      setAddress(v.address ?? '');
      setPort(String(v.port ?? 443));
      setUuid(v.uuid ?? '');
      setPublicKey(v.publicKey ?? '');
      setShortId(v.shortId ?? '');
      setSni(v.sni ?? '');
      setFlow(v.flow ?? 'xtls-rprx-vision');
      setFingerprint(v.fingerprint ?? 'chrome');
      setAutoStart(!!v.autoStart);
      try {
        if (await getEmbeddedVpnRunning()) setStatus('on');
      } catch {
        /* статус останется off */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const applyParsedLink = useCallback(() => {
    const trimmed = link.trim();
    if (!trimmed) {
      showError('Вставьте ссылку vless://');
      return;
    }
    const p = parseVlessUrl(trimmed);
    if (!p) {
      showError('Не удалось разобрать ссылку. Проверьте формат vless://');
      return;
    }
    setAddress(p.address);
    setPort(String(p.port));
    setUuid(p.uuid);
    if (p.publicKey) setPublicKey(p.publicKey);
    if (p.shortId) setShortId(p.shortId);
    if (p.sni) setSni(p.sni);
    if (p.flow) setFlow(p.flow);
    if (p.fingerprint) setFingerprint(p.fingerprint);
    showSuccess('Ссылка разобрана — проверьте поля и сохраните');
  }, [link]);

  /** Собрать полный VpnConfig (defaults + поля формы). null при ошибке валидации. */
  const buildVpnConfig = useCallback(
    (enabled: boolean): VpnConfig | null => {
      const base = getConfigSync().vpn;
      if (!base) {
        showError('Конфигурация недоступна');
        return null;
      }
      const addr = address.trim();
      const id = uuid.trim();
      const pbk = publicKey.trim();
      const sid = shortId.trim();
      const portNum = Number(port.trim());
      if (!addr || !id || !pbk || !sid) {
        showError('Заполните адрес, UUID, publicKey и shortId');
        return null;
      }
      if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
        showError('Некорректный порт');
        return null;
      }
      return {
        ...base,
        enabled,
        autoStart,
        address: addr,
        port: portNum,
        uuid: id,
        publicKey: pbk,
        shortId: sid,
        sni: sni.trim() || base.sni,
        flow: flow.trim() || base.flow,
        fingerprint: fingerprint.trim() || base.fingerprint,
      };
    },
    [address, uuid, publicKey, shortId, port, sni, flow, fingerprint, autoStart],
  );

  const saveBtn = useAsyncButton(async () => {
    const vpn = buildVpnConfig(true);
    if (!vpn) return;
    await saveConfigOverride({ vpn } as Partial<AppConfig>);
    showSuccess('Настройки VPN сохранены');
  });

  const connectBtn = useAsyncButton(async () => {
    const vpn = buildVpnConfig(true);
    if (!vpn) return;
    const cfg = await saveConfigOverride({ vpn } as Partial<AppConfig>);
    setStatus('starting');
    const s = await retryEmbeddedVpn(cfg);
    setStatus(s);
    if (s === 'on') showSuccess('VPN подключён');
    else if (s === 'failed') showError('Не удалось подключиться. Проверьте данные сервера');
    else if (s === 'unsupported') showError('VPN недоступен на этом устройстве');
  });

  const disconnectBtn = useAsyncButton(async () => {
    await stopEmbeddedVpn();
    setStatus('off');
    showSuccess('VPN отключён');
  });

  const styles = useThemedStyles((c) => ({
    sectionTitle: {
      color: c.textSecondary,
      fontSize: 13,
      fontWeight: '600' as const,
      marginTop: 16,
      marginBottom: 8,
    },
    hint: { color: c.textMuted, fontSize: 12, marginBottom: 8, lineHeight: 16 },
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      padding: 12,
    },
    label: { color: c.text, fontSize: 14, fontWeight: '600' as const, marginBottom: 4 },
    fieldGroup: { marginBottom: 10 },
    input: {
      backgroundColor: c.background,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 14,
    },
    linkRow: { flexDirection: 'row' as const, gap: 8, alignItems: 'flex-start' as const },
    linkInput: { flex: 1 },
    parseBtn: {
      backgroundColor: c.surfaceHigh,
      borderRadius: 8,
      paddingHorizontal: 12,
      justifyContent: 'center' as const,
      minHeight: 38,
    },
    parseBtnText: { color: c.text, fontSize: 13, fontWeight: '600' as const },
    switchRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      marginTop: 4,
      marginBottom: 8,
    },
    statusRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      marginBottom: 12,
    },
    statusDot: { width: 10, height: 10, borderRadius: 5 },
    statusText: { fontSize: 13, fontWeight: '600' as const },
    btnRow: { flexDirection: 'row' as const, gap: 10, marginTop: 4 },
    primaryBtn: {
      flex: 1,
      backgroundColor: c.primary,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      justifyContent: 'center' as const,
      gap: 6,
    },
    // v4.32.400: содержимое акцентной кнопки считается из её заливки. Акцент
    // выбирает пользователь, и белое на нём гарантировано только для белого;
    // вписанное руками '#fff' этой гарантии не видит.
    primaryOn: { color: contrastingInk(c.primary) },
    primaryBtnText: { color: contrastingInk(c.primary), fontSize: 14, fontWeight: '700' as const },
    secondaryBtn: {
      flex: 1,
      backgroundColor: c.surfaceHigh,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center' as const,
    },
    secondaryBtnText: { color: c.text, fontSize: 14, fontWeight: '700' as const },
    statusColorOn: { color: c.success },
    statusColorWarn: { color: c.warning },
    statusColorErr: { color: c.error },
    statusColorOff: { color: c.textMuted },
    dotOn: { backgroundColor: c.success },
    dotWarn: { backgroundColor: c.warning },
    dotErr: { backgroundColor: c.error },
    dotOff: { backgroundColor: c.textMuted },
    primaryColor: { color: c.accent },
    placeholderColor: { color: c.textMuted },
  }));

  const statusStyle =
    status === 'on'
      ? { text: styles.statusColorOn, dot: styles.dotOn }
      : status === 'starting'
        ? { text: styles.statusColorWarn, dot: styles.dotWarn }
        : status === 'failed' || status === 'unsupported'
          ? { text: styles.statusColorErr, dot: styles.dotErr }
          : { text: styles.statusColorOff, dot: styles.dotOff };

  const field = (
    labelText: string,
    value: string,
    setter: (s: string) => void,
    opts?: { placeholder?: string; keyboardType?: 'default' | 'numeric'; autoCapitalize?: 'none' },
  ) => (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{labelText}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={setter}
        placeholder={opts?.placeholder}
        placeholderTextColor={styles.placeholderColor.color}
        keyboardType={opts?.keyboardType ?? 'default'}
        autoCapitalize={opts?.autoCapitalize ?? 'none'}
        autoCorrect={false}
      />
    </View>
  );

  const running = status === 'on' || status === 'starting';

  return (
    <View>
      <Text style={styles.sectionTitle}>VPN (обход блокировок)</Text>
      <Text style={styles.hint}>
        Свой сервер VLESS+Reality. Вставьте ссылку vless:// от провайдера или заполните поля вручную.
        Данные хранятся только на этом устройстве.
      </Text>
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, statusStyle.dot]} />
          <Text style={[styles.statusText, statusStyle.text]}>{STATUS_LABEL[status]}</Text>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Ссылка vless://</Text>
          <View style={styles.linkRow}>
            <TextInput
              style={[styles.input, styles.linkInput]}
              value={link}
              onChangeText={setLink}
              placeholder="vless://uuid@host:443?..."
              placeholderTextColor={styles.placeholderColor.color}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <Pressable style={styles.parseBtn} onPress={applyParsedLink}>
              <Text style={styles.parseBtnText}>Разобрать</Text>
            </Pressable>
          </View>
        </View>

        {field('Адрес сервера', address, setAddress, { placeholder: 'vps.example.com' })}
        {field('Порт', port, setPort, { placeholder: '443', keyboardType: 'numeric' })}
        {field('UUID', uuid, setUuid, { placeholder: '00000000-0000-...' })}
        {field('Public key (pbk)', publicKey, setPublicKey)}
        {field('Short ID (sid)', shortId, setShortId)}
        {field('SNI', sni, setSni, { placeholder: 'microsoft.com' })}
        {field('Flow', flow, setFlow, { placeholder: 'xtls-rprx-vision' })}
        {field('Fingerprint', fingerprint, setFingerprint, { placeholder: 'chrome' })}

        <View style={styles.switchRow}>
          <Text style={styles.label}>Подключать автоматически при запуске</Text>
          <AppSwitch
            value={autoStart}
            onValueChange={setAutoStart}
          />
        </View>

        <View style={styles.btnRow}>
          <Pressable
            style={styles.secondaryBtn}
            onPress={saveBtn.onPress}
            disabled={saveBtn.loading}
          >
            {saveBtn.loading ? (
              <ActivityIndicator color={styles.primaryColor.color} />
            ) : (
              <Text style={styles.secondaryBtnText}>Сохранить</Text>
            )}
          </Pressable>
          {running ? (
            <Pressable
              style={styles.primaryBtn}
              onPress={disconnectBtn.onPress}
              disabled={disconnectBtn.loading}
            >
              {disconnectBtn.loading ? (
                <ActivityIndicator color={styles.primaryOn.color} />
              ) : (
                <>
                  <Ionicons name="power" size={16} color={styles.primaryOn.color} />
                  <Text style={styles.primaryBtnText}>Отключить</Text>
                </>
              )}
            </Pressable>
          ) : (
            <Pressable
              style={styles.primaryBtn}
              onPress={connectBtn.onPress}
              disabled={connectBtn.loading}
            >
              {connectBtn.loading ? (
                <ActivityIndicator color={styles.primaryOn.color} />
              ) : (
                <>
                  <Ionicons name="shield-checkmark" size={16} color={styles.primaryOn.color} />
                  <Text style={styles.primaryBtnText}>Сохранить и подключить</Text>
                </>
              )}
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}
