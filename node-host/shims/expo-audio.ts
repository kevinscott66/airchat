/**
 * Node-замена `expo-audio`. Граница платформы.
 *
 * Звуковое устройство у процесса без сессии отсутствует. В ядре отсюда живёт
 * `backgroundKeepalive`: он проигрывает тишину, чтобы iOS не усыпила
 * приложение со свёрнутым окном. В Node усыплять некому — процесс работает,
 * пока его не остановят, — так что и приём этот здесь не нужен.
 *
 * Отказ громкий: `initBackgroundKeepalive` вызывается в обёртке с журналом,
 * и запись «звука нет» в журнале лучше, чем молчаливо не заведённый
 * проигрыватель, о котором вызывающий будет думать, что тот играет.
 */
export type AudioPlayer = {
  play: () => void;
  pause: () => void;
  remove: () => void;
  loop: boolean;
  volume: number;
};

export function createAudioPlayer(): AudioPlayer {
  throw new Error('audio_unavailable_on_node: createAudioPlayer');
}

export async function setAudioModeAsync(): Promise<void> {
  throw new Error('audio_unavailable_on_node: setAudioModeAsync');
}

export function useAudioPlayer(): AudioPlayer {
  throw new Error('audio_unavailable_on_node: useAudioPlayer');
}

export default { createAudioPlayer, setAudioModeAsync, useAudioPlayer };
