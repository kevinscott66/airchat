/**
 * Туннель OpenFlux: один переключатель (v4.32.723).
 *
 * Здесь нарочно нет ни одного поля ввода — в отличие от соседней секции VPN,
 * где пользователь вбивает свой сервер. Адрес документа приходит переменной
 * сборки и является ключом (см. config.openflux), показывать и тем более
 * давать править его в интерфейсе незачем: настраивать тут нечего, решение
 * ровно одно — вести трафик через документ или не вести.
 *
 * Поэтому переключатель действует сразу, без «Сохранить»: человек включает
 * его в сети, где приложение уже не работает, и лишний шаг в этот момент —
 * это ещё одна возможность не догадаться, что нужно нажать что-то ещё.
 * Решение при этом запоминается (saveConfigOverride), иначе туннель, который
 * выключили осознанно, возвращался бы при каждом запуске.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppSwitch } from './AppSwitch';
import { font, radius } from '../theme';
import { useThemedStyles } from '../ThemeContext';
import { useAsyncButton } from '../../core/hooks/useAsyncButton';
import { showError, showSuccess } from './userFeedback';
import { userErrorText } from './userErrorText';
import { getConfigSync, loadConfig, saveConfigOverride, type AppConfig } from '../../core/config';
import { loadKeyPair } from '../../core/crypto/keyManager';
import {
  startInternetTransportIfEnabled,
  stopInternetTransportStack,
} from '../../core/transport/internet/internetCoordinator';
import {
  getOpenFluxRunning,
  getOpenFluxSocksAddr,
  retryOpenFlux,
  stopOpenFlux,
  type OpenFluxUiStatus,
} from '../../core/vpn/openFluxController';

const STATUS_LABEL: Record<OpenFluxUiStatus, string> = {
  off: 'Выключен',
  starting: 'Поднимаю канал…',
  on: 'Работает',
  failed: 'Не удалось поднять',
  unsupported: 'Недоступно на этом устройстве',
  unconfigured: 'В этой сборке нет ссылки на документ',
};

export function OpenFluxSettingsSection(): React.ReactElement {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<OpenFluxUiStatus>('off');
  const [socks, setSocks] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const cfg = await loadConfig();
      if (!alive) return;
      setEnabled(!!cfg.openflux?.enabled);
      try {
        if (await getOpenFluxRunning()) {
          if (!alive) return;
          setStatus('on');
          setSocks(await getOpenFluxSocksAddr());
        }
      } catch {
        /* статус останется off */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** Записать решение пользователя в override и вернуть свежий конфиг. */
  const persist = useCallback(async (on: boolean): Promise<AppConfig> => {
    const base = getConfigSync().openflux;
    return saveConfigOverride({
      openflux: { ...base, enabled: on },
    } as Partial<AppConfig>);
  }, []);

  /**
   * Переподнять интернет-транспорт после переключения туннеля.
   *
   * Подмена маршрута (ProxySelector на стороне Android) действует только на
   * НОВЫЕ соединения. Веб-сокет ntfy — главный канал приложения — к этому
   * моменту уже открыт и продолжит идти прежним путём, пока его не закроют.
   * Без перезапуска включение туннеля выглядело бы как «нажал, и ничего не
   * изменилось», а выключение оставляло бы трафик в уже погашенном SOCKS5.
   *
   * Тот же приём, что и при смене адреса relay (см. RelaySettingsSection):
   * сначала остановить, потом поднять заново — иначе координатор помнит, что
   * уже запущен, и старт молча выходит.
   */
  const restartTransport = useCallback(async (cfg: AppConfig): Promise<void> => {
    stopInternetTransportStack();
    if (cfg.internet?.enabled === false) return;
    const pair = await loadKeyPair();
    // Ключей ещё нет — значит, транспорт и не стартовал: поднимать нечего.
    if (!pair) return;
    await startInternetTransportIfEnabled(pair, cfg);
  }, []);

  const onToggle = useCallback(
    async (on: boolean) => {
      // Переключатель двигаем сразу: канал поднимается секундами, и застывший
      // в прежнем положении рычажок в этот момент читается как «не нажалось».
      setEnabled(on);
      setBusy(true);
      try {
        const cfg = await persist(on);
        if (!on) {
          await stopOpenFlux();
          setStatus('off');
          setSocks(null);
          await restartTransport(cfg);
          return;
        }
        setStatus('starting');
        const s = await retryOpenFlux(cfg);
        setStatus(s);
        if (s === 'on') {
          setSocks(await getOpenFluxSocksAddr());
          await restartTransport(cfg);
          showSuccess('Канал через документ поднят');
        } else if (s === 'failed') {
          showError('Не удалось поднять канал. Проверьте, открывается ли документ');
        }
      } catch (e) {
        setStatus('failed');
        showError(userErrorText(e, 'Не удалось переключить туннель'));
      } finally {
        setBusy(false);
      }
    },
    [persist, restartTransport],
  );

  const retryBtn = useAsyncButton(async () => {
    const cfg = await loadConfig();
    setStatus('starting');
    const s = await retryOpenFlux(cfg);
    setStatus(s);
    if (s === 'on') {
      setSocks(await getOpenFluxSocksAddr());
      await restartTransport(cfg);
      showSuccess('Канал через документ поднят');
    } else {
      showError('Снова не вышло. Проверьте документ и сеть');
    }
  });

  const styles = useThemedStyles((c) => ({
    sectionTitle: {
      color: c.textSecondary,
      fontSize: font.sm,
      fontWeight: '600' as const,
      marginTop: 16,
      marginBottom: 8,
    },
    hint: { color: c.textMuted, fontSize: font.xs, marginBottom: 8, lineHeight: 16 },
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      padding: 12,
    },
    switchRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      gap: 12,
    },
    switchLabel: { color: c.text, fontSize: font.md, fontWeight: '600' as const, flexShrink: 1 },
    statusRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 8,
      marginTop: 10,
    },
    statusDot: { width: 10, height: 10, borderRadius: radius.full },
    statusText: { fontSize: font.sm, fontWeight: '600' as const },
    socks: { color: c.textMuted, fontSize: font.xs, marginTop: 6 },
    retryBtn: {
      marginTop: 12,
      backgroundColor: c.surfaceHigh,
      borderRadius: radius.md,
      paddingVertical: 10,
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      justifyContent: 'center' as const,
      gap: 6,
    },
    retryText: { color: c.text, fontSize: font.sm, fontWeight: '700' as const },
    dotOn: { backgroundColor: c.success },
    dotWarn: { backgroundColor: c.warning },
    dotErr: { backgroundColor: c.error },
    dotOff: { backgroundColor: c.textMuted },
    onColor: { color: c.success },
    warnColor: { color: c.warning },
    errColor: { color: c.error },
    offColor: { color: c.textMuted },
    accent: { color: c.accent },
  }));

  const tone =
    status === 'on'
      ? { text: styles.onColor, dot: styles.dotOn }
      : status === 'starting'
        ? { text: styles.warnColor, dot: styles.dotWarn }
        : status === 'failed'
          ? { text: styles.errColor, dot: styles.dotErr }
          : { text: styles.offColor, dot: styles.dotOff };

  // Повтор предлагаем только там, где он может помочь. При «нет ссылки» и
  // «недоступно на устройстве» кнопка была бы обманом: сколько ни нажимай,
  // результат один и тот же.
  const canRetry = enabled && status === 'failed';

  return (
    <View>
      <Text style={styles.sectionTitle}>OPENFLUX (СЕТИ С БЕЛЫМ СПИСКОМ)</Text>
      <Text style={styles.hint}>
        Когда оператор пускает только разрешённые сайты, приложение не достучится до сервера
        доставки напрямую. OpenFlux несёт трафик внутри документа Яндекса — адрес, который в
        белый список уже входит. В обычной сети туннель можно выключить: без него быстрее.
      </Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Вести трафик через документ</Text>
          <AppSwitch
            value={enabled}
            onValueChange={(v) => {
              void onToggle(v);
            }}
            disabled={busy}
            testID="openflux_switch"
          />
        </View>

        <View style={styles.statusRow}>
          <View style={[styles.statusDot, tone.dot]} />
          <Text style={[styles.statusText, tone.text]}>{STATUS_LABEL[status]}</Text>
          {busy ? <ActivityIndicator size="small" color={styles.accent.color} /> : null}
        </View>

        {socks && status === 'on' ? (
          <Text style={styles.socks}>Локальный SOCKS5: {socks}</Text>
        ) : null}

        {canRetry ? (
          <Pressable style={styles.retryBtn} onPress={retryBtn.onPress} disabled={retryBtn.loading}>
            {retryBtn.loading ? (
              <ActivityIndicator color={styles.accent.color} />
            ) : (
              <>
                <Ionicons name="refresh" size={16} color={styles.accent.color} />
                <Text style={styles.retryText}>Повторить</Text>
              </>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
