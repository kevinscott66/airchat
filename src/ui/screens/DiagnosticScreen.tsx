import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { AppPressable } from '../components/AppPressable';
import { Ionicons } from '@expo/vector-icons';
import { loadConfig } from '../../core/config';
import {
  formatLanDiagnostics,
} from '../../core/transport/localTransportDiagnostics';
import { getEmbeddedVpnRunning } from '../../core/vpn/airChatVpnController';
import { SafeScreen } from '../components/SafeScreen';
import { useThemedStyles, useColors } from '../ThemeContext';
import { primaryInk, radius } from '../theme';
import { rawErrorText } from '../components/userErrorText';

/**
 * Выходной узел в цепочке Xray задаётся на сервере, не в assets/config.json
 * клиента.
 *
 * v4.32.528: здесь стоял конкретный адрес выхода — литералом, в открытом
 * репозитории. Клиент к нему не обращается (см. комментарий выше), то есть
 * строка была только подписью на экране, но подписью, публикующей рабочий узел
 * вместе с портом. Знать этот адрес приложение и не может: он живёт на сервере
 * и меняется без пересборки, так что литерал вдобавок устаревал молча — а
 * подпись «ожидаемый выходной узел» звучит тем увереннее, чем она старее.
 *
 * Проверка цепочки всё равно делается не в приложении: клиент видит только
 * вход. Поэтому экран теперь говорит, где смотреть, вместо того чтобы называть
 * адрес, который он не проверял.
 */
const FOREIGN_EXIT_HINT = 'задаётся на сервере (в приложении не хранится)';

function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

type Props = {
  onClose: () => void;
};

export function DiagnosticScreen({ onClose }: Props): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [vpnLine, setVpnLine] = useState('—');
  const [signalingLine, setSignalingLine] = useState('—');
  const [russianLine, setRussianLine] = useState('—');
  const [foreignLine, setForeignLine] = useState('—');
  const [lanLocalLine, setLanLocalLine] = useState('—');

  const colors = useColors();
  const styles = useThemedStyles((c) => ({
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'space-between' as const,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' as const },
    scroll: { flex: 1, backgroundColor: c.background },
    content: { padding: 16, paddingBottom: 32 },
    intro: { color: c.textSecondary, fontSize: 13, lineHeight: 18, marginBottom: 16 },
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      padding: 14,
      marginBottom: 12,
    },
    label: { fontSize: 13, color: c.textMuted, marginBottom: 6 },
    value: { fontSize: 14, color: c.text, lineHeight: 20 },
    hint: { fontSize: 12, color: c.textMuted, marginTop: 8 },
    button: {
      backgroundColor: c.primary,
      padding: 14,
      borderRadius: radius.lg,
      alignItems: 'center' as const,
      marginTop: 8,
    },
    buttonDisabled: { opacity: 0.7 },
    buttonText: { color: primaryInk(c).text, fontSize: 16, fontWeight: '600' as const },
  }));

  // v4.32.192 (Round-22 #5): alive flag for the 12s+8s sequence of awaits.
  // Without it, setXxxLine runs on unmounted component when user leaves the
  // screen during a slow HEAD probe.
  const aliveRef = useRef(true);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const running = await getEmbeddedVpnRunning();
      if (!aliveRef.current) return;
      setVpnLine(running ? 'Туннель запущен (локальный SOCKS активен)' : 'Туннель не запущен');

      const cfg = await loadConfig();
      if (!aliveRef.current) return;
      const base = cfg.webrtc?.signalingUrl ?? '';
      if (base) {
        try {
          const res = await fetchWithTimeout(`${base}/health`, 12000);
          const text = await res.text();
          if (!aliveRef.current) return;
          setSignalingLine(res.ok ? `OK ${res.status}: ${text.slice(0, 120)}` : `HTTP ${res.status}`);
        } catch (e) {
          if (!aliveRef.current) return;
          setSignalingLine(rawErrorText(e));
        }
      } else {
        setSignalingLine('Не задан signalingUrl в конфиге');
      }

      const addr = cfg.vpn?.address?.trim();
      const port = cfg.vpn?.port ?? 8443;
      if (addr) {
        setRussianLine(`Из конфига: ${addr}:${port} (VLESS+Reality — не HTTP /health)`);
        try {
          await fetchWithTimeout(`https://${addr}:${port}/`, 8000, { method: 'HEAD' });
          if (!aliveRef.current) return;
          setRussianLine((prev) => `${prev}\nПопытка HEAD: ответ получен (редко для Xray).`);
        } catch (e) {
          if (!aliveRef.current) return;
          const msg = rawErrorText(e);
          setRussianLine(
            `Из конфига: ${addr}:${port}. TLS/HTTP с телефона: ${msg} — для входа Xray это часто нормально; проверка с Mac: nc -zv ${addr} ${port}`
          );
        }
      } else {
        setRussianLine('В конфиге не задан адрес входа');
      }

      if (!aliveRef.current) return;
      setForeignLine(
        `В приложении задаётся только вход (см. выше). Выход ${FOREIGN_EXIT_HINT}; проверка цепочки — tcpdump на VPS или логи Xray.`
      );
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void run();
    return () => { aliveRef.current = false; };
  }, [run]);

  /** LAN/BLE: обновляем пиры mDNS периодически (Android — два телефона в одной Wi‑Fi). */
  useEffect(() => {
    if (Platform.OS !== 'android') {
      setLanLocalLine('LAN (локально): подробности — на Android с нативной сборкой.');
      return;
    }
    const tick = () => {
      setLanLocalLine(formatLanDiagnostics());
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => clearInterval(id);
  }, []);

  return (
    <SafeScreen edges={['left', 'right', 'top']} style={{ flex: 1 }}>
      <View style={styles.header}>
        <AppPressable onPress={onClose} hitSlop={12} testID="diagnostic_close">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </AppPressable>
        <Text style={styles.headerTitle}>Диагностика связи</Text>
        <View style={{ width: 24 }} />
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.intro}>
          Проверка доступности сигнального сервера и состояния встроенного туннеля. Входной и выходной узлы Xray
          различаются: клиент подключается только к адресу из конфигурации.
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>Встроенный туннель (Android)</Text>
          <Text style={styles.value}>{vpnLine}</Text>
        </View>

        {Platform.OS === 'android' && (
          <>
            <View style={styles.card}>
              <Text style={styles.label}>Локальная сеть (Wi‑Fi, без интернета)</Text>
              <Text style={styles.value}>{lanLocalLine}</Text>
            </View>
          </>
        )}

        <View style={styles.card}>
          <Text style={styles.label}>Сигнальный сервер (WebRTC)</Text>
          <Text style={styles.value}>{signalingLine}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Входной узел (из конфига приложения)</Text>
          <Text style={styles.value}>{russianLine}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Выход в сеть (цепочка на сервере)</Text>
          <Text style={styles.value}>{foreignLine}</Text>
          <Text style={styles.hint}>Ожидаемый выходной узел: {FOREIGN_EXIT_HINT}</Text>
        </View>

        <AppPressable
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={() => void run()}
          disabled={busy}
          testID="diagnostic_retry"
        >
          {busy ? (
            <ActivityIndicator color={primaryInk(colors).text} />
          ) : (
            <Text style={styles.buttonText}>Проверить снова</Text>
          )}
        </AppPressable>
      </ScrollView>
    </SafeScreen>
  );
}
