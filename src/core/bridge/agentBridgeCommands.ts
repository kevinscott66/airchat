/**
 * Что мост умеет — и, что важнее, чего он не умеет (v4.32.723).
 *
 * ГРАНИЦА. Здесь нет ни отправки сообщений, ни чтения переписки, ни работы с
 * контактами, и это не недоделка. Всё перечисленное синхронизируется через
 * облако, и внешний headless-клиент делает это сам, напрямую. Вторая
 * реализация того же самого разошлась бы с первой — не сразу и не заметно, а
 * на третьей правке протокола, и разошлась бы в сторону «сообщение ушло по
 * одному пути и не появилось на другом».
 *
 * Мост нужен ровно для того, чего headless-клиент не может в принципе:
 *  • туннель OpenFlux — операция внутри процесса приложения (поднять локальный
 *    SOCKS5 и увести в него сетевой стек), его состояние нигде не хранится и
 *    никуда не синхронизируется;
 *  • `AppConfig` — файл `airchat-config.json` в песочнице КАЖДОЙ установки,
 *    он не синхронизируется и на другом устройстве другой;
 *  • настройки, намеренно оставленные привязанными к устройству: уведомления
 *    и оформление (почему именно — см. `storage/kvKeys`).
 *
 * ЧЕСТНОСТЬ ОТВЕТА ПРО ТУННЕЛЬ. «Недоступно на этой платформе» и «выключено»
 * — разные ответы, и агент по ним принимает разные решения: в первом случае
 * просить включить туннель бессмысленно навсегда, во втором — осмысленно
 * прямо сейчас. Различение уже сделано в `vpn/openFluxController`
 * (`unsupported` против `off`), и терять его по дороге нельзя.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { log } from '../logger';
import { kvGet, kvSetChecked } from '../storage/local';
import { loadConfig, saveConfigOverride, type AppConfig } from '../config';
import { restartInternetTransport } from '../transport/internet/restartInternetTransport';
import {
  getOpenFluxRunning,
  getOpenFluxSocksAddr,
  retryOpenFlux,
  stopOpenFlux,
  type OpenFluxUiStatus,
} from '../vpn/openFluxController';
// Модуль интерфейса в ядре — осознанно. `OPENFLUX_AVAILABLE` это единственный
// в проекте ответ на вопрос «есть ли на этой платформе ядро OpenFlux», он не
// тянет за собой ничего, кроме `Platform`, и — главное — когда ядро принесут
// под iOS, поменяется именно эта строка. Своя копия проверки в ядре осталась
// бы лежать как есть, и мост продолжал бы отвечать «недоступно» там, где
// туннель уже работает. Это ровно та ложь, ради недопущения которой здесь всё
// и различается.
import { OPENFLUX_AVAILABLE } from '../../ui/platformCapabilities';

/** Разобранная команда. Больше в кадре ничего и нет. */
export type BridgeCommand = { cmd: string; arg?: unknown };

export type BridgeReply =
  | { ok: true; cmd: string; result: unknown }
  | { ok: false; cmd: string; error: string; message: string };

/**
 * Состояние туннеля в ответе моста.
 *
 * Подмножество `OpenFluxUiStatus`: `starting` сюда не попадает, потому что
 * команда возвращается уже после того, как попытка закончилась.
 */
export type BridgeOpenFluxState = Exclude<OpenFluxUiStatus, 'starting'>;

/**
 * Разделы конфига, которые мост отдаёт и принимает.
 *
 * Списком, а не «всё, кроме»: в `AppConfig` лежат и токены сторонних сервисов
 * (`publicServices`, `whitelist.services.*.token`), и адрес облачной копии.
 * Перечисление запрещённого пришлось бы дополнять при каждом новом разделе, и
 * однажды его не дополнили бы — а перечисление разрешённого при таком же
 * недосмотре всего лишь не даст править новый раздел.
 */
export const CONFIG_SECTIONS = [
  'internet',
  'ipfs',
  'webrtc',
  'lan',
  'mesh',
  'bypass',
  'openflux',
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

/**
 * Поля внутри разрешённых разделов, которые мост не показывает и не принимает.
 *
 * Раздел разрешён целиком, а внутри него может лежать не настройка, а ключ.
 * `openflux.docUrl` — ровно такой случай: ссылка на документ и есть право
 * писать в него, и обе нативные части специально не пишут её в журнал
 * (`AirChatOpenFluxModule.swift`, `.kt` — «logcat читается с устройства кем
 * угодно»). Отдав её по `config.get`, мост подарил бы это право всякому, у
 * кого оказался ключ доступа; приняв её по `config.set`, позволил бы перевести
 * весь туннелированный трафик на чужой транзит — и это пережило бы перезапуск
 * приложения, потому что правка ложится в `airchat-config.json`.
 *
 * Список, а не «всё, что похоже на URL»: полей мало, каждое надо назвать и
 * объяснить, а угадывание по виду значения однажды пропустит новое.
 */
const SECRET_FIELDS: ReadonlyArray<{ section: ConfigSection; field: string }> = [
  { section: 'openflux', field: 'docUrl' },
];

/** Что стоит в ответе вместо значения ключа: факт наличия без самого ключа. */
const SECRET_PLACEHOLDER = '<скрыто мостом>';

/**
 * Настройки, привязанные к устройству.
 *
 * Те самые, что не синхронизируются и потому недоступны headless-клиенту:
 * поведение телефона (звонить ли, вибрировать, показывать ли текст на замке)
 * и оформление. Имена взяты у тех, кто их пишет: `SettingsScreen` и
 * `ThemeContext`.
 */
export const DEVICE_SETTING_KEYS = [
  'notify_dm',
  'notify_groups',
  'notify_calls',
  'notify_feed',
  'notify_mentions',
  'notify_preview',
  'notify_vibrate',
  'notify_sound',
  'app_theme_mode',
  'app_font_size',
  'app_accent_color',
  'auto_night_mode',
  'auto_night_start',
  'auto_night_end',
] as const;

export type DeviceSettingKey = (typeof DEVICE_SETTING_KEYS)[number];

/** Длиннее этого ни одна из перечисленных настроек не бывает. */
const MAX_SETTING_VALUE_CHARS = 64;

function fail(cmd: string, error: string, message: string): BridgeReply {
  return { ok: false, cmd, error, message };
}

function appVersion(): string {
  return String(Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? 'unknown');
}

/**
 * Состояние туннеля без попытки его поднять.
 *
 * Порядок проверок — от самого безусловного к самому частному. Сначала
 * платформа: там, где ядра нет, всё остальное не имеет значения и ответ
 * «недоступно» верен независимо от конфига. Потом отсутствие ссылки на
 * документ: такую сборку никакое нажатие не спасёт. И только потом «поднят
 * или нет».
 */
async function openFluxState(cfg: AppConfig): Promise<{
  state: BridgeOpenFluxState;
  socks: string | null;
}> {
  if (!OPENFLUX_AVAILABLE) return { state: 'unsupported', socks: null };
  if (!cfg.openflux?.docUrl?.trim()) return { state: 'unconfigured', socks: null };
  const running = await getOpenFluxRunning();
  if (!running) return { state: 'off', socks: null };
  return { state: 'on', socks: await getOpenFluxSocksAddr() };
}

/** Убрать из ответа `starting`: наружу оно приезжать не должно. */
function settled(status: OpenFluxUiStatus): BridgeOpenFluxState {
  return status === 'starting' ? 'on' : status;
}

async function cmdOpenFluxEnable(): Promise<BridgeReply> {
  const before = await loadConfig();
  if (!OPENFLUX_AVAILABLE) {
    // Отказ, а не молчаливое «выключено»: запрос был осмысленный, невыполним
    // он по причине, которую агенту надо знать целиком.
    return fail(
      'openflux.enable',
      'unsupported',
      'На этой платформе нет ядра OpenFlux: включать нечего.',
    );
  }
  if (!before.openflux?.docUrl?.trim()) {
    return fail(
      'openflux.enable',
      'unconfigured',
      'В этой сборке нет ссылки на документ: туннель вести некуда.',
    );
  }
  // Флаг пишется ДО попытки. `retryOpenFlux` отказывается поднимать туннель,
  // выключенный в конфиге, и это правильно — иначе «выключить» в настройках
  // перестало бы что-то значить. Значит, включение это ровно две вещи в
  // строгом порядке: записать решение, потом поднять.
  const cfg = await saveConfigOverride({
    openflux: { ...before.openflux, enabled: true },
  } as Partial<AppConfig>);
  const status = settled(await retryOpenFlux(cfg));
  if (status === 'on') await restartInternetTransport(cfg);
  const socks = status === 'on' ? await getOpenFluxSocksAddr() : null;
  return { ok: true, cmd: 'openflux.enable', result: { state: status, socks } };
}

async function cmdOpenFluxDisable(): Promise<BridgeReply> {
  const before = await loadConfig();
  if (!OPENFLUX_AVAILABLE) {
    return fail(
      'openflux.disable',
      'unsupported',
      'На этой платформе нет ядра OpenFlux: выключать нечего.',
    );
  }
  await stopOpenFlux();
  const cfg = await saveConfigOverride({
    openflux: { ...(before.openflux ?? {}), enabled: false },
  } as Partial<AppConfig>);
  // Перезапуск нужен и при выключении: иначе главный канал остался бы в уже
  // погашенном SOCKS5 (см. restartInternetTransport).
  await restartInternetTransport(cfg);
  return { ok: true, cmd: 'openflux.disable', result: { state: 'off', socks: null } };
}

function pickSections(cfg: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const section of CONFIG_SECTIONS) {
    if (cfg[section] !== undefined) out[section] = cfg[section];
  }
  // Ключи не показываем, но и не прячем сам факт: агенту надо уметь отличить
  // «в сборке нет туннеля» от «есть, просто ссылку тебе не дали» — иначе он
  // станет чинить не то. Копия раздела делается здесь же: `cfg` пришёл из
  // `loadConfig`, и затирать поле в нём значило бы стереть ссылку у всех,
  // кто держит тот же объект.
  for (const { section, field } of SECRET_FIELDS) {
    const value = out[section];
    if (!value || typeof value !== 'object') continue;
    const copy = { ...(value as Record<string, unknown>) };
    if (typeof copy[field] === 'string' && copy[field] !== '') copy[field] = SECRET_PLACEHOLDER;
    out[section] = copy;
  }
  return out;
}

async function cmdConfigSet(arg: unknown): Promise<BridgeReply> {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    return fail('config.set', 'bad_arg', 'Ожидался объект с разделами конфига.');
  }
  const patch = arg as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    return fail('config.set', 'bad_arg', 'Пустая правка: менять нечего.');
  }
  const forbidden = keys.filter((k) => !(CONFIG_SECTIONS as readonly string[]).includes(k));
  if (forbidden.length > 0) {
    return fail(
      'config.set',
      'section_not_allowed',
      `Мост не правит разделы: ${forbidden.join(', ')}. Разрешены: ${CONFIG_SECTIONS.join(', ')}.`,
    );
  }
  // Раздел разрешён — это ещё не значит, что разрешено всё внутри него. См.
  // SECRET_FIELDS: правка `openflux.docUrl` переводит весь туннелированный
  // трафик на чужой транзит и переживает перезапуск, потому что ложится в
  // `airchat-config.json`. Заодно это отсекает «верни обратно то, что получил»:
  // в ответе `config.get` на месте ссылки стоит SECRET_PLACEHOLDER, и
  // невнимательный агент записал бы в конфиг именно его.
  for (const { section, field } of SECRET_FIELDS) {
    const value = patch[section];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!(field in (value as Record<string, unknown>))) continue;
    return fail(
      'config.set',
      'field_not_allowed',
      `Мост не правит ${section}.${field}: это ключ доступа, а не настройка. Меняйте его в сборке.`,
    );
  }

  const cfg = await saveConfigOverride(patch as Partial<AppConfig>);
  // Адрес ретранслятора и туннель меняют путь трафика, а путь действует
  // только на новые соединения — главный канал надо переоткрыть.
  if (keys.includes('internet') || keys.includes('openflux')) {
    await restartInternetTransport(cfg);
  }
  return { ok: true, cmd: 'config.set', result: { applied: keys, config: pickSections(cfg) } };
}

async function cmdSettingsSet(arg: unknown): Promise<BridgeReply> {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    return fail('settings.set', 'bad_arg', 'Ожидался объект «имя настройки — значение».');
  }
  const values = arg as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length === 0) {
    return fail('settings.set', 'bad_arg', 'Пустая правка: менять нечего.');
  }
  const unknownKeys = keys.filter((k) => !(DEVICE_SETTING_KEYS as readonly string[]).includes(k));
  if (unknownKeys.length > 0) {
    return fail(
      'settings.set',
      'key_not_allowed',
      `Мост не правит настройки: ${unknownKeys.join(', ')}.`,
    );
  }
  const bad = keys.filter((k) => {
    const v = values[k];
    return typeof v !== 'string' || v.length > MAX_SETTING_VALUE_CHARS;
  });
  if (bad.length > 0) {
    return fail(
      'settings.set',
      'bad_value',
      `Значение должно быть строкой не длиннее ${MAX_SETTING_VALUE_CHARS} символов: ${bad.join(', ')}.`,
    );
  }
  // v4.32.961: здесь стоял `kvSet`, а он гасит отказ базы и отдаёт void —
  // ровно то, из-за чего в соседнем `agentBridge` (v4.32.801) запись решения о
  // мосте уже проверяется. Разница в том, кому мост врёт: он отвечает не
  // человеку, а агенту, и агент по `ok: true` докладывает «сделано». Человек
  // просил вернуть уведомления, база в ту секунду была занята — не легло
  // ничего, а узнает он об этом, только когда сообщения перестанут приходить,
  // и искать будет где угодно, только не в настройке, которую ему подтвердили.
  // Отдельно про середину списка: отказ на втором ключе из трёх оставлял
  // половину записанной, а в ответе всё равно стоял весь список — по такому
  // ответу нечего даже повторить.
  const applied: string[] = [];
  const failed: string[] = [];
  for (const k of keys) {
    if (await kvSetChecked(k, values[k] as string)) applied.push(k);
    else failed.push(k);
  }
  if (failed.length > 0) {
    log.warn('bridge_settings_set_write_failed', { applied: applied.length, failed: failed.length });
    // Отказной ответ моста не носит `result` — поэтому что успело лечь,
    // называем словами: без этого агент не отличит «не записалось ничего» от
    // «записалось половину» и будет повторять вслепую.
    return fail(
      'settings.set',
      'write_failed',
      applied.length > 0
        ? `Записано: ${applied.join(', ')}. Не записано: ${failed.join(', ')}. База была занята, повторите.`
        : `Не записано: ${failed.join(', ')}. База была занята, повторите.`,
    );
  }
  // Честно про отложенность: оформление читается при запуске (ThemeContext), и
  // запущенное приложение перекрашивается не от записи, а от перезапуска.
  // Уведомления читаются в момент показа, они действуют сразу.
  const appearanceTouched = keys.some((k) => k.startsWith('app_') || k.startsWith('auto_night_'));
  return {
    ok: true,
    cmd: 'settings.set',
    result: {
      applied,
      note: appearanceTouched
        ? 'Оформление запущенное приложение перечитает при следующем запуске.'
        : undefined,
    },
  };
}

async function cmdSettingsGet(): Promise<BridgeReply> {
  const entries = await Promise.all(
    DEVICE_SETTING_KEYS.map(async (k) => [k, await kvGet(k)] as const),
  );
  return { ok: true, cmd: 'settings.get', result: Object.fromEntries(entries) };
}

/**
 * Исполнить команду.
 *
 * Неизвестное имя — это отказ с перечислением того, что мост умеет, а не
 * молчание. Молчание неотличимо от «телефон спит», и агент, получив его,
 * начинает ждать и повторять вместо того, чтобы исправить опечатку.
 */
export async function runBridgeCommand(command: BridgeCommand): Promise<BridgeReply> {
  const { cmd, arg } = command;
  try {
    switch (cmd) {
      case 'whoami': {
        const cfg = await loadConfig();
        return {
          ok: true,
          cmd,
          result: {
            appVersion: appVersion(),
            platform: Platform.OS,
            // Не `boolean`: «нет ядра» и «ядро есть, но выключено» должны
            // читаться из ответа без домысливания.
            openFlux: OPENFLUX_AVAILABLE ? 'available' : 'unsupported',
            openFluxState: (await openFluxState(cfg)).state,
            bridgeProtocol: 1,
          },
        };
      }
      case 'openflux.status': {
        const cfg = await loadConfig();
        return { ok: true, cmd, result: await openFluxState(cfg) };
      }
      case 'openflux.enable':
        return await cmdOpenFluxEnable();
      case 'openflux.disable':
        return await cmdOpenFluxDisable();
      case 'config.get':
        return { ok: true, cmd, result: pickSections(await loadConfig()) };
      case 'config.set':
        return await cmdConfigSet(arg);
      case 'settings.get':
        return await cmdSettingsGet();
      case 'settings.set':
        return await cmdSettingsSet(arg);
      default:
        return fail(
          cmd,
          'unknown_command',
          `Мост не знает команды «${cmd}». Умеет: ${KNOWN_COMMANDS.join(', ')}.`,
        );
    }
  } catch (e) {
    // Текст падения уходит в журнал целиком, агенту — только опознаватель:
    // сообщения библиотек бывают длинными и содержат пути внутри песочницы.
    log.warn('agent_bridge_command_failed', {
      cmd,
      err: e instanceof Error ? e.message : String(e),
    });
    return fail(cmd, 'command_failed', 'Команда не выполнена, подробности в журнале устройства.');
  }
}

export const KNOWN_COMMANDS = [
  'whoami',
  'openflux.status',
  'openflux.enable',
  'openflux.disable',
  'config.get',
  'config.set',
  'settings.get',
  'settings.set',
] as const;

/** Разбор полезной части кадра. Всё, что не похоже на команду, — не команда. */
export function parseCommand(payload: unknown): BridgeCommand | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as { cmd?: unknown; arg?: unknown };
  if (typeof p.cmd !== 'string' || !p.cmd || p.cmd.length > 64) return null;
  return { cmd: p.cmd, arg: p.arg };
}
