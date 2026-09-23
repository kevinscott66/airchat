/**
 * Запуск ядра AirChat вне телефона.
 *
 * На устройстве той же работой занят `useEffect` в `src/App.tsx`: он ждёт
 * первого кадра, следит за сменой аккаунта, отменяет себя при размонтировании.
 * Здесь ничего этого нет и не должно быть — процесс живёт ровно одну личность
 * от старта до остановки, — поэтому последовательность переписана обычной
 * async-функцией, а не скопирована вместе с реактивной обвязкой.
 *
 * Порядок шагов сохранён от App.tsx, и он не произволен:
 *
 *   1. рабочий каталог — до всего, иначе шимы не знают, куда писать;
 *   2. база — первой, чтобы `loadConfig` и реестр профилей читали kv, а не
 *      натыкались на незаведённую схему;
 *   3. seed — до `profileManager.init()`, потому что реестр профилей выводит
 *      пары ключей из мнемоники и без неё отвечает «not ready»;
 *   4. messaging — до транспорта: координатор интернета при получении кадра
 *      идёт за `getMessagingService()`, и кадр, пришедший в промежуток, было
 *      бы некому разобрать.
 *
 * Чего здесь намеренно нет: LAN и Wi-Fi Direct (нативных модулей нет),
 * звонков (нет WebRTC), push (нет notifee), ленты и синхронизации аккаунта.
 * Последнее — не техническое ограничение: `syncActiveAccount` заводит на
 * сервере ещё одно устройство, занимает слот и начинает удерживать журнал
 * мутаций. Headless-экземпляр, поднятый ради проверки, не должен появляться
 * в чужом списке устройств.
 */
import * as path from 'node:path';

import { setWorkdir, workdir } from './runtime/workdir';
import { attachLogSink, detachLogSink } from './runtime/logBus';

import { loadConfig, type AppConfig } from '../src/core/config';
import type { KeyPairBytes } from '../src/core/crypto/keyManager';
import { publicKeyToDidKey } from '../src/core/identity/did';
import { profileManager } from '../src/core/identity/profileManager';
import { getStoredMnemonic, restoreFromMnemonic } from '../src/core/backup/seedPhrase';
import { getMessagingService, initMessagingService } from '../src/core/social/messaging';
import {
  ensureLocalStorageReadyForBoot,
  closeLocalDatabase,
} from '../src/core/storage/local';
import {
  startInternetTransportIfEnabled,
  stopInternetTransportStack,
} from '../src/core/transport/internet/internetCoordinator';

export type StartCoreOptions = {
  /** Корень, в котором этот экземпляр держит базу, файлы и secure-store. */
  workdir: string;
  /**
   * Секретные слова аккаунта.
   *
   * Нужны только при заведении каталога: дальше они лежат в secure-store, и
   * запуск обходится без них — именно так и работает сервер, которому фразу
   * не передают ни в окружении, ни в аргументах. Если в каталоге личности нет
   * и слов не дали, запуск отказывает: завести новый аккаунт молча нельзя —
   * он ничем не отличается от потерянного.
   */
  mnemonic?: string;
};

export type CoreHandle = {
  did: string;
  pid: number;
  pair: KeyPairBytes;
  config: AppConfig;
};

let running: CoreHandle | null = null;

/**
 * Куда девается вывод логгера в headless-процессе.
 *
 * В релизной сборке `log.*` по умолчанию молчит: без файлового приёмника он
 * дублирует в консоль только отобранные маркеры, и то через
 * `globalThis.__airchatOrigConsoleLog`, который ставит `index.ts` — точка входа
 * приложения, которой здесь нет. То есть без этой строки ядро в Node не
 * сказало бы ни слова даже про отказ транспорта: наружу вернулся бы `null`, а
 * причина осталась бы внутри. На телефоне её потом читают из adb, здесь читать
 * нечего — поэтому сразу файл рядом с базой.
 *
 * Приёмник не ставится напрямую: место у логгера одно, а читателя стало два —
 * файл и разбор причин отказа (см. `runtime/logBus`).
 */
function installLogSink(): void {
  attachLogSink(path.join(workdir(), 'core.log'));
}

/** Уже поднятое ядро, или `null`. */
export function currentCore(): CoreHandle | null {
  return running;
}

export async function startCore(options: StartCoreOptions): Promise<CoreHandle> {
  if (running) throw new Error('core_already_running');

  setWorkdir(options.workdir);
  installLogSink();

  // 1. Хранилище. `ensureLocalStorageReadyForBoot` — это открытие базы и
  //    прогон миграций; всё, что ниже, пишет и читает уже через неё.
  await ensureLocalStorageReadyForBoot();

  // 2. Личность. Слова кладутся в secure-store только если их там ещё нет:
  //    `restoreFromMnemonic` на повторном запуске увидит те же самые и сам
  //    распознает «тот же кошелёк», но лишний раз трогать ключевую запись
  //    незачем — каждая перезапись это ещё один шанс её потерять.
  const stored = await getStoredMnemonic();
  if (stored === null) {
    if (!options.mnemonic) {
      // Отказ, а не молчаливое заведение нового аккаунта. Новый аккаунт здесь
      // выглядел бы как рабочий — с DID, базой и сокетом, — но это была бы
      // чужая личность, и первое же сообщение ушло бы не от того, от кого
      // человек его ждёт. Заведение — отдельное действие с отдельной командой.
      throw new Error('core_no_identity: в каталоге нет аккаунта, а слова не переданы');
    }
    await restoreFromMnemonic(options.mnemonic);
  } else if (options.mnemonic && stored !== options.mnemonic.trim().split(/\s+/).join(' ')) {
    // Молча работать с чужой личностью нельзя: вызывающий назвал одни слова,
    // а в каталоге лежат другие — значит, каталог принадлежит другому
    // аккаунту. Перезаписывать его — потерять тот, что там был.
    throw new Error('workdir_belongs_to_another_wallet');
  }

  await profileManager.init();
  const pair = profileManager.getActiveKeyPair();
  const pid = profileManager.getActiveProfile()?.id ?? 1;
  const did = publicKeyToDidKey(pair.publicKey);

  const config = await loadConfig();

  // 3. Переписка. Служба создаётся до транспорта — см. пояснение сверху.
  initMessagingService(pair);

  // 4. Транспорт. Единственный доступный здесь — интернет через релей.
  await startInternetTransportIfEnabled(pair, config);

  running = { did, pid, pair, config };
  return running;
}

/**
 * Остановка. Порядок обратный запуску, как и в teardown у App.tsx: сначала
 * транспорт (он держит сокет и может в любой момент отдать кадр), затем
 * служба переписки (ей этот кадр разбирать), и только потом база — закрыть её
 * раньше значило бы уронить разбор кадра на полуслове.
 *
 * Отказ на любом шаге не прерывает остановку: недозакрытый сокет — это утечка
 * дескриптора, а недозакрытая база — испорченный WAL. Поэтому каждый шаг
 * выполняется, а его ошибка копится и выбрасывается в конце, а не глотается.
 */
export async function stopCore(): Promise<void> {
  if (!running) return;
  const failures: string[] = [];
  const step = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await step('internet_transport', () => stopInternetTransportStack());
  await step('messaging', () => getMessagingService()?.dispose());
  await step('local_database', () => closeLocalDatabase());

  running = null;
  // Приёмник снимается последним: всё, что писали шаги выше, должно было
  // попасть в файл, включая их собственные жалобы на неудачное закрытие.
  detachLogSink();
  if (failures.length > 0) throw new Error(`core_stop_incomplete: ${failures.join('; ')}`);
}
