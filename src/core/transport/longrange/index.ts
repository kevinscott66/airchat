import { log } from '../../logger';
import { loadKeyPair } from '../../crypto/keyManager';
import { publicKeyToDidKey } from '../../identity/did';
import { GeographicRouter } from './geographicRouter';
// v4.32.204: HF/LoRa не реализовываем — выключены (user directive).
// import { HFRadioTransport } from './hfRadio';
// import { LoRaTransport } from './lora';
import { OpportunisticSync } from './opportunisticSync';
import { isLongRangePipelineEnabled } from './pipelineFlag';
import { RelayService } from './relayService';
import { getWiFiMeshTransport, type WiFiMeshTransport } from './wifiMesh';

export { GeographicRouter } from './geographicRouter';
// export { HFRadioTransport } from './hfRadio';
// export { LoRaTransport } from './lora';
export { OpportunisticSync } from './opportunisticSync';
export { isLongRangePipelineEnabled, LONG_RANGE_PIPELINE_ENABLED } from './pipelineFlag';
export { RelayService } from './relayService';
export type { RelayPacket } from './relayService';
export { WiFiMeshTransport } from './wifiMesh';
export type { WiFiMeshSendOutcome } from './wifiMesh';

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
 * Инициализация long-range транспортов (Wi-Fi Direct mesh / geo / relay;
 * HF и LoRa выключены продуктовым решением).
 * Повторный вызов при уже поднятом транспорте ничего не делает.
 *
 * Пока конвейер не доведён (см. pipelineFlag.ts), вызов — no-op: нативная
 * группа Wi-Fi Direct и обнаружение не поднимаются вовсе.
 */
export function initLongRangeTransport(): Promise<void> {
  if (!isLongRangePipelineEnabled()) return lifecycle.then(() => undefined);
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
 * остановить Wi-Fi Direct (обнаружение, группа в эфире, таблица узлов,
 * обработчик найденных устройств). После разбора initLongRangeTransport
 * поднимает всё заново — уже на текущей личности.
 */
export function shutdownLongRangeTransport(): Promise<void> {
  lifecycle = lifecycle.then(
    async (current) => {
      if (!current) return null;
      // Каждая половина разбирается сама: сбой ретрансляции не должен
      // оставить группу Wi-Fi Direct висеть в эфире, и наоборот.
      try {
        current.relay.dispose();
      } catch (e) {
        log.warn('longrange_shutdown_failed', { err: e instanceof Error ? e.message : String(e) });
      }
      try {
        await current.wifiMesh.stop();
      } catch (e) {
        log.warn('longrange_shutdown_failed', { err: e instanceof Error ? e.message : String(e) });
      }
      log.debug('[AirChat] longrange transport shut down');
      return null;
    },
    () => null
  );
  return lifecycle.then(() => undefined);
}

/** DID текущей личности — для ретрансляции и для обмена при встрече. */
async function getMyDid(): Promise<string> {
  try {
    const kp = await loadKeyPair();
    if (kp?.publicKey?.length) return publicKeyToDidKey(kp.publicKey);
  } catch (e) {
    log.warn('longrange_get_my_did_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  return 'did:key:z6Mkpending';
}

async function startLongRangeTransport(): Promise<Running> {
  const geo = new GeographicRouter();
  await geo.hydrateFromDb();

  const wifiMesh = getWiFiMeshTransport();
  // deliverPayload намеренно не передаётся: у Wi-Fi Direct нет приёмной
  // стороны и формата кадра (см. pipelineFlag.ts). Без доставщика
  // синхронизация ничего не отправляет и не опустошает очереди.
  const sync = new OpportunisticSync({ geographicRouter: geo, getMyDid });

  // v4.32.204: HF/LoRa не реализуем — выключены (user directive).
  //
  // Координаты: источника пока нет. Жёсткая точка (0,0) убрана — она строила
  // маршруты от несуществующего места; без координат findPath честно пуст.

  const relay = new RelayService({ geographicRouter: geo, getMyDid });
  await relay.enableRelayMode();

  // Обработчик ставится ДО обнаружения: scanAndConnect сообщает о найденных
  // узлах прямо по ходу, и подписка, поставленная после, теряла весь первый
  // скан.
  wifiMesh.onDeviceFound((d) => {
    void sync.onDeviceDetected(d);
  });
  try {
    await wifiMesh.startAccessPoint();
    await wifiMesh.scanAndConnect();
  } catch (e) {
    // Подъём сорвался посередине: всё уже поднятое разбираем, иначе группа
    // осталась бы в эфире, а ретрансляция — со слушателем заряда.
    relay.dispose();
    await wifiMesh.stop();
    throw e;
  }

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
