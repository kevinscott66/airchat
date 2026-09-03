/**
 * backgroundKeepalive — тихий звук, чтобы свёрнутое приложение слышало звонок
 * (v4.32.559).
 *
 * На iOS пуша у нас нет вовсе: FCM едет по APNs, а ключи APNs принадлежат
 * командам, чьими сертификатами подписаны сборки. Значит, свёрнутое приложение
 * узнаёт о входящем звонке ровно столько времени, сколько живёт его сокет, —
 * а сокет живёт столько, сколько система даёт фону: секунды.
 *
 * Единственное, что iOS оставляет работать в фоне без сделки с Apple, — это
 * воспроизведение звука. У приложения с `UIBackgroundModes: audio`, у которого
 * играет дорожка, сессия не засыпает, и сокет остаётся живым вместе с ней.
 * Дорожка — пять секунд на −90 дБ: неслышимо, но это не цифровая тишина,
 * которую система вправе счесть за «звука нет».
 *
 * Честная цена — батарея, поэтому:
 *  • только iOS: на Android есть FCM и фоновая задача, там это лишний расход;
 *  • есть выключатель `bg_keepalive` (по умолчанию включён — без него на
 *    iPhone звонок в свёрнутое приложение не приходит никак);
 *  • режим `mixWithOthers`: чужая музыка и подкасты не глохнут;
 *  • во время разговора молчим — аудиосессией владеет сам звонок, и лезть в
 *    неё вторым игроком значит рисковать разговором ради его же поддержания.
 *
 * Это подпорка, а не замена пуша. Настоящее решение — свой APNs-ключ платного
 * аккаунта разработчика; до него живём так. Смежное — [server-side журнал
 * непринятых звонков](../transport/webrtc/signaling.ts): он ловит тех, кого
 * не спас ни сокет, ни это.
 */

import { AppState, Platform, type AppStateStatus } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { log } from '../logger';
import { kvGet } from '../storage/local';
import { subscribeCall } from './callService';

/** Ключ настройки в kv. Отсутствие ключа означает «включено». */
export const KEEPALIVE_KEY = 'bg_keepalive';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SILENCE = require('../../../assets/audio/silence.wav');

let appStateSub: { remove(): void } | null = null;
let unsubscribeCall: (() => void) | null = null;
let player: AudioPlayer | null = null;

let enabled = true;
let backgrounded = false;
let inCall = false;

/** Только для тестов: играет ли сейчас поддерживающая дорожка. */
export function isBackgroundKeepaliveRunning(): boolean {
  return player !== null;
}

function shouldRun(): boolean {
  return Platform.OS === 'ios' && enabled && backgrounded && !inCall;
}

async function start(): Promise<void> {
  if (player) return;
  try {
    await setAudioModeAsync({
      shouldPlayInBackground: true,
      playsInSilentMode: true,
      interruptionMode: 'mixWithOthers',
      allowsRecording: false,
    });
    // Ставим игрока только после того, как сессия согласована: иначе первая
    // же дорожка уйдёт в старую категорию и фон её оборвёт.
    const created = createAudioPlayer(SILENCE, { updateInterval: 60_000 });
    created.loop = true;
    created.play();
    player = created;
    log.info('bg_keepalive_started');
  } catch (e) {
    log.warn('bg_keepalive_start_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

async function stop(): Promise<void> {
  const current = player;
  player = null;
  if (!current) return;
  try {
    current.pause();
    current.remove();
  } catch (e) {
    log.warn('bg_keepalive_stop_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  // Фоновую сессию отпускаем только когда разговора нет: во время звонка её
  // держит сам звонок, и снять флаг значило бы оборвать разговор в фоне.
  if (inCall) return;
  try {
    await setAudioModeAsync({ shouldPlayInBackground: false });
  } catch { /* режим вернёт следующий, кому он понадобится */ }
}

function sync(): void {
  if (shouldRun()) void start();
  else void stop();
}

function onAppState(next: AppStateStatus): void {
  backgrounded = next !== 'active';
  sync();
}

/**
 * Включает или выключает поддержание связи. Значение уже должно быть записано
 * в kv вызывающей стороной — здесь только состояние в памяти.
 */
export function setBackgroundKeepaliveEnabled(on: boolean): void {
  enabled = on;
  sync();
}

/** Поднимает поддержание связи. Повторный вызов ничего не ломает. */
export async function initBackgroundKeepalive(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (appStateSub) return;
  enabled = (await kvGet(KEEPALIVE_KEY)) !== 'false';
  backgrounded = AppState.currentState !== 'active';
  appStateSub = AppState.addEventListener('change', onAppState);
  unsubscribeCall = subscribeCall((info) => {
    const busy = info !== null && info.state !== 'idle' && info.state !== 'ended';
    if (busy === inCall) return;
    inCall = busy;
    sync();
  });
  sync();
}

/** Снимает подписки и глушит дорожку. */
export async function disposeBackgroundKeepalive(): Promise<void> {
  appStateSub?.remove();
  appStateSub = null;
  unsubscribeCall?.();
  unsubscribeCall = null;
  backgrounded = false;
  inCall = false;
  await stop();
}
