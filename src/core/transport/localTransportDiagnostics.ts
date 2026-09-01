/**
 * Короткие строки для UI (Диагностика): LAN mDNS.
 * Только Android в прод-сборке с нативными модулями даёт полную картину.
 */
import { Platform } from 'react-native';
import { getLanTransportSingleton } from './lan/lanTransport';

export function formatLanDiagnostics(): string {
  if (Platform.OS === 'web') {
    return 'LAN (локальная сеть): в web-сборке не используется.';
  }
  const t = getLanTransportSingleton();
  if (!t.isActive()) {
    return [
      'LAN (Wi‑Fi, сервис _airchat._tcp через mDNS): не запущен.',
      'Запускается после входа в приложение, если в конфиге lan.enabled.',
      'Два устройства в одной подсети Wi‑Fi должны увидеть друг друга в списке ниже после 30–60 с.',
    ].join('\n');
  }
  const peers = t.getPeers();
  let s = `LAN: активен, обнаружено пиров: ${peers.length}`;
  for (const p of peers.slice(0, 6)) {
    s += `\n· ${p.did.slice(0, 32)}… → ${p.host}:${p.port}`;
  }
  if (peers.length > 6) s += `\n… и ещё ${peers.length - 6}`;
  return s;
}
