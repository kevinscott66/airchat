import { log } from '../../logger';
import { loadKeyPair } from '../../crypto/keyManager';
import { publicKeyToDidKey } from '../../identity/did';
import { GeographicRouter } from './geographicRouter';
// v4.32.204: HF/LoRa не реализовываем — выключены (user directive).
// import { HFRadioTransport } from './hfRadio';
// import { LoRaTransport } from './lora';
import { OpportunisticSync } from './opportunisticSync';
import { RelayService } from './relayService';
import { getWiFiMeshTransport, type WiFiMeshTransport } from './wifiMesh';

export { GeographicRouter } from './geographicRouter';
// export { HFRadioTransport } from './hfRadio';
// export { LoRaTransport } from './lora';
export { OpportunisticSync } from './opportunisticSync';
export { RelayService } from './relayService';
export type { RelayPacket } from './relayService';
export { WiFiMeshTransport } from './wifiMesh';

/** Что подняла последняя удавшаяся инициализация — то и разбираем. */
type Running = { relay: RelayService; wifiMesh: WiFiMeshTransport };

/**
 * v4.32.501: цикл жизни long-range — одна последовательная цепочка.
 *
 * Раньше подъём защищал модульный флаг didInit, который никогда не сбрасывался,
 * а разбора не было вовсе. После выхода из аккаунта (или переключения личности)
 * ретрансляция оставалась поднятой на прежних ключах: слушатель уровня заряда,
 * очередь пакетов с таймерами повторов и обработчик найденных устройств,
 * замкнутый на уже ненужную синхронизацию. Заново поднять long-range было
 * нельзя — флаг всё ещё говорил «уже подняли».
 *
 * Подъём и разбор нельзя пускать внахлёст: обе половины трогают один и тот же
 * синглтон Wi-Fi-транспорта, и разбор, начатый посреди подъёма, снял бы
 * обработчик у только что запущенного цикла. Поэтому обе половины встают в
 * общую очередь — тот же приём, что у службы уведомлений (lifecycleQueue),
 * только здесь по цепочке едет ещё и состояние.
 */
let lifecycle: Promise<Running | null> = Promise.resolve(null);

/**
 * Инициализация long-range транспортов (HF / LoRa / mesh / geo / relay).
 * Реальное железо — через нативные модули; здесь поднимаются симуляции и SQLite для geo.
 * Повторный вызов при уже поднятом транспорте ничего не делает.
 */
export function initLongRangeTransport(): Promise<void> {
  lifecycle = lifecycle.then(
    async (current) => {
      if (current) return current;
      try {
        return await startLongRangeTransport();
      } catch (e) {
        // Цепочка не имеет права порваться: вызывающая сторона запускает
        // подъём через `void`, и отказ ушёл бы в необработанное отклонение.
        // Ничего не поднялось — следующий вызов попробует заново.
        log.warn('longrange_start_failed', { err: e instanceof Error ? e.message : String(e) });
        return null;
      }
    },
    () => null
  );
  return lifecycle.then(() => undefined);
}

/**
 * Разбор long-range: снять слушатель заряда и таймеры повторов у ретрансляции,
 * отпустить обработчик найденных устройств. После разбора initLongRangeTransport
 * поднимает всё заново — уже на текущей личности.
 */
export function shutdownLongRangeTransport(): Promise<void> {
  lifecycle = lifecycle.then(
    (current) => {
      try {
        if (current) {
          current.relay.dispose();
          current.wifiMesh.clearDeviceFoundHandler();
          log.debug('[AirChat] longrange transport shut down');
        }
      } catch (e) {
        log.warn('longrange_shutdown_failed', { err: e instanceof Error ? e.message : String(e) });
      }
      return null;
    },
    () => null
  );
  return lifecycle.then(() => undefined);
}

async function startLongRangeTransport(): Promise<Running> {
  const geo = new GeographicRouter();
  await geo.hydrateFromDb();

  const wifiMesh = getWiFiMeshTransport();
  const sync = new OpportunisticSync({ geographicRouter: geo });

  // v4.32.204: HF/LoRa симуляция выключена (user directive, не реализуем).
  // const hf = new HFRadioTransport({
  //   port: '',
  //   baudRate: 9600,
  //   frequency: 7.1,
  //   mode: 'usb',
  //   power: 5,
  //   simulate: true,
  // });
  // void hf.connect();
  //
  // const lora = new LoRaTransport({
  //   port: '',
  //   baudRate: 115200,
  //   channel: 0,
  //   encryptionKey: '',
  //   simulate: true,
  // });
  // void lora.connect();

  await geo.updateMyLocation(async () => ({ lat: 0, lon: 0 }));
  await wifiMesh.startAccessPoint();
  await wifiMesh.scanAndConnect();

  const relay = new RelayService({
    geographicRouter: geo,
    getMyDid: async () => {
      try {
        const kp = await loadKeyPair();
        if (kp?.publicKey?.length) return publicKeyToDidKey(kp.publicKey);
      } catch (e) {
        log.warn('longrange_get_my_did_failed', { err: e instanceof Error ? e.message : String(e) });
      }
      return 'did:key:z6Mkpending';
    },
  });
  await relay.enableRelayMode();

  wifiMesh.onDeviceFound((d) => {
    void sync.onDeviceDetected(d);
  });

  if (__DEV__) {
    log.info('longrange_transport_ready', {
      mesh: 'wifi-p2p-or-off',
      geo: 'sqlite+dijkstra',
      hf: 'disabled',
      lora: 'disabled',
    });
  }

  return { relay, wifiMesh };
}
