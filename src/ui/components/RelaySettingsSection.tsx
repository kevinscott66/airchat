/**
 * Секция настроек сервера доставки (v4.32.330).
 *
 * Сообщения между устройствами в разных сетях идут через ntfy-совместимый
 * ретранслятор. Транспорт умел работать с любым адресом с v4.32.70, но задать
 * его можно было только правкой Documents/airchat-config.json — с телефона
 * никак. По умолчанию это публичный ntfy.sh: чужие ограничения, чужая
 * доступность, и список тем виден его владельцу (сами сообщения зашифрованы,
 * relay видит только шифротекст — см. internetTransport).
 *
 * Здесь — ввод своего адреса, проверка, что он вправду отвечает, и
 * переподключение транспорта на месте. Координатор транспорта помечен @stable
 * и не тронут: связка stopInternetTransportStack() + startInternetTransportIfEnabled()
 * — его собственный публичный интерфейс.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useThemedStyles } from '../ThemeContext';
import { contrastingInk } from '../theme';
import { AppSwitch } from './AppSwitch';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import { showError, showSuccess } from './userFeedback';
import { loadConfig, saveConfigOverride, type AppConfig } from '../../core/config';
import { loadKeyPair } from '../../core/crypto/keyManager';
import {
  DEFAULT_RELAY_BASE,
  DEFAULT_WS_BASE,
  isCustomRelay,
  parseRelayInput,
} from '../../core/transport/internet/relayConfig';
import { probeRelay } from '../../core/transport/internet/relayProbe';
import {
  startInternetTransportIfEnabled,
  stopInternetTransportStack,
} from '../../core/transport/internet/internetCoordinator';

/** Результат последней проверки — показывается строкой под полем. */
type CheckState = { kind: 'ok' | 'err' | 'warn'; text: string } | null;

export function RelaySettingsSection(): React.ReactElement {
  const [input, setInput] = useState('');
  const [enabled, setEnabled] = useState(true);
  /** Адрес, который сейчас реально используется транспортом. */
  const [activeBase, setActiveBase] = useState(DEFAULT_RELAY_BASE);
  const [check, setCheck] = useState<CheckState>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const cfg = await loadConfig();
      if (!alive) return;
      const base = cfg.internet?.relayBase ?? DEFAULT_RELAY_BASE;
      setActiveBase(base);
      // В поле подставляется только свой адрес: ntfy.sh — это «ничего не
      // настроено», и предлагать его как заготовку для правки незачем.
      setInput(isCustomRelay(base) ? base : '');
      setEnabled(cfg.internet?.enabled !== false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Перезапускает транспорт под новой конфигурацией.
   *
   * Без остановки старт молча выйдет: координатор помнит, что уже запущен, и
   * подписка осталась бы на прежнем сервере до перезапуска приложения.
   */
  const restartTransport = useCallback(async (cfg: AppConfig): Promise<boolean> => {
    stopInternetTransportStack();
    if (cfg.internet?.enabled === false) return true;
    const pair = await loadKeyPair();
    if (!pair) return false;
    await startInternetTransportIfEnabled(pair, cfg);
    return true;
  }, []);

  const checkBtn = useAsyncButton(async () => {
    const parsed = parseRelayInput(input);
    if (!parsed.ok) {
      setCheck({ kind: 'err', text: parsed.error });
      return;
    }
    setCheck(null);
    const res = await probeRelay(parsed.endpoints.relayBase);
    if (!res.ok) {
      setCheck({ kind: 'err', text: res.error });
      return;
    }
    setCheck({
      kind: parsed.warning ? 'warn' : 'ok',
      text: parsed.warning ? `${res.detail}. ${parsed.warning}` : res.detail,
    });
  });

  const saveBtn = useAsyncButton(async () => {
    const parsed = parseRelayInput(input);
    if (!parsed.ok) {
      setCheck({ kind: 'err', text: parsed.error });
      showError(parsed.error);
      return;
    }
    // Проверка перед сохранением, а не после: ошибиться в адресе легко, а
    // последствия молчаливые — сообщения просто перестанут доходить.
    const res = await probeRelay(parsed.endpoints.relayBase);
    if (!res.ok) {
      setCheck({ kind: 'err', text: res.error });
      showError(res.error);
      return;
    }
    const cfg = await saveConfigOverride({
      internet: { enabled, relayBase: parsed.endpoints.relayBase, wsBase: parsed.endpoints.wsBase },
    } as Partial<AppConfig>);
    setActiveBase(parsed.endpoints.relayBase);
    setCheck(
      parsed.warning ? { kind: 'warn', text: parsed.warning } : { kind: 'ok', text: res.detail },
    );
    if (await restartTransport(cfg)) showSuccess('Сервер сохранён, доставка переключена');
    else showError('Сервер сохранён, но переподключиться не удалось — перезапустите приложение');
  });

  const resetBtn = useAsyncButton(async () => {
    const cfg = await saveConfigOverride({
      internet: { enabled, relayBase: DEFAULT_RELAY_BASE, wsBase: DEFAULT_WS_BASE },
    } as Partial<AppConfig>);
    setInput('');
    setActiveBase(DEFAULT_RELAY_BASE);
    setCheck(null);
    if (await restartTransport(cfg)) showSuccess('Возвращён общий сервер ntfy.sh');
    else showError('Настройка сохранена, но переподключиться не удалось — перезапустите приложение');
  });

  /** Переключатель применяется сразу: иначе непонятно, нажата кнопка или нет. */
  const onToggleEnabled = useCallback(
    (next: boolean) => {
      setEnabled(next);
      void (async () => {
        const cfg = await saveConfigOverride({
          internet: { enabled: next, relayBase: activeBase },
        } as Partial<AppConfig>);
        await restartTransport(cfg);
      })();
    },
    [activeBase, restartTransport],
  );

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
    statusRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      marginBottom: 12,
    },
    statusDot: { width: 10, height: 10, borderRadius: 5 },
    statusText: { fontSize: 13, fontWeight: '600' as const, flexShrink: 1 },
    switchRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      gap: 12,
      marginBottom: 10,
    },
    switchLabel: { color: c.text, fontSize: 14, fontWeight: '600' as const, flexShrink: 1 },
    checkLine: { fontSize: 12, lineHeight: 16, marginTop: -4, marginBottom: 10 },
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
    resetBtn: { paddingVertical: 12, alignItems: 'center' as const },
    resetBtnText: { color: c.textMuted, fontSize: 13, fontWeight: '600' as const },
    okColor: { color: c.success },
    warnColor: { color: c.warning },
    errColor: { color: c.error },
    mutedColor: { color: c.textMuted },
    dotOn: { backgroundColor: c.success },
    dotOff: { backgroundColor: c.textMuted },
    primaryColor: { color: c.accent },
    placeholderColor: { color: c.textMuted },
  }));

  const custom = isCustomRelay(activeBase);
  const checkStyle =
    check?.kind === 'ok' ? styles.okColor : check?.kind === 'warn' ? styles.warnColor : styles.errColor;

  return (
    <View>
      <Text style={styles.sectionTitle}>Сервер доставки</Text>
      <Text style={styles.hint}>
        Через него сообщения доходят до собеседников в других сетях. Сами сообщения зашифрованы —
        сервер видит только шифротекст, — но список тем и время отправки видны его владельцу.
        Свой сервер: любой ntfy (docs.ntfy.sh).
      </Text>
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, enabled ? styles.dotOn : styles.dotOff]} />
          <Text
            style={[styles.statusText, enabled ? styles.okColor : styles.mutedColor]}
            numberOfLines={1}
          >
            {!enabled ? 'Выключен — только локальная сеть' : custom ? activeBase : 'Общий ntfy.sh'}
          </Text>
        </View>

        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Доставка через интернет</Text>
          <AppSwitch
            value={enabled}
            onValueChange={onToggleEnabled}
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Адрес своего сервера</Text>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={(t) => {
              setInput(t);
              setCheck(null);
            }}
            placeholder="ntfy.example.com"
            placeholderTextColor={styles.placeholderColor.color}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={enabled}
          />
        </View>

        {check ? (
          <Text style={[styles.checkLine, checkStyle]}>{check.text}</Text>
        ) : null}

        <View style={styles.btnRow}>
          <Pressable
            style={styles.secondaryBtn}
            onPress={checkBtn.onPress}
            disabled={checkBtn.loading || !enabled}
          >
            {checkBtn.loading ? (
              <ActivityIndicator color={styles.primaryColor.color} />
            ) : (
              <Text style={styles.secondaryBtnText}>Проверить</Text>
            )}
          </Pressable>
          <Pressable
            style={styles.primaryBtn}
            onPress={saveBtn.onPress}
            disabled={saveBtn.loading || !enabled}
          >
            {saveBtn.loading ? (
              <ActivityIndicator color={styles.primaryOn.color} />
            ) : (
              <>
                <Ionicons name="cloud-upload-outline" size={16} color={styles.primaryOn.color} />
                <Text style={styles.primaryBtnText}>Сохранить</Text>
              </>
            )}
          </Pressable>
        </View>

        {custom ? (
          <Pressable style={styles.resetBtn} onPress={resetBtn.onPress} disabled={resetBtn.loading}>
            {resetBtn.loading ? (
              <ActivityIndicator color={styles.primaryColor.color} />
            ) : (
              <Text style={styles.resetBtnText}>Вернуть общий ntfy.sh</Text>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
