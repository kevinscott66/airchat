/**
 * voiceUriPolicy — какой адрес голосового сообщения можно отдать плееру.
 *
 * v4.32.242. Конверт голосового всегда несёт uri той записи, что лежит на
 * устройстве отправителя (makeVoiceText получает результат диктофона и никогда
 * ничего другого — так было с первой версии). Значит для получателя чужой uri
 * бесполезен: играть можно только то, что мы соберём сами из CID шлюза, либо
 * то, что придёт зашифрованным блобом.
 *
 * В личных чатах это учитывали наполовину: MediaStrip пропускал чужой uri,
 * если он начинался с http(s)/ipfs. В группах не проверяли вообще — пузырь
 * отдавал meta.uri плееру как есть. Так участник группы мог:
 *   • подставить http(s)-адрес своего сервера — тот срабатывает при нажатии
 *     на «играть» и выдаёт отправителю IP-адрес и время прослушивания (тот же
 *     класс маяка, что и предпросмотр ссылок, см. linkPreviewPolicy);
 *   • подставить file:// или content:// — и плеер в чужом приложении открыл бы
 *     локальный файл получателя.
 *
 * Поэтому решение вынесено сюда одной функцией и вызывается из обоих
 * отрисовщиков: забыть проверку в третьем месте уже нельзя.
 */

import { gatewayUrl } from '../media/gatewayUrl';

export type VoiceUriInput = {
  /** uri из конверта (для входящих — под контролем собеседника). */
  metaUri: string;
  /** Своё сообщение: uri указывает на нашу же запись и заведомо локальный. */
  isOutgoing: boolean;
  /** CID из mediaCids, если он есть (личные чаты с доступным IPFS). */
  cid?: string | null;
  /** Адрес шлюза из настроек. */
  gateway?: string | null;
};

/**
 * Возвращает адрес для плеера или пустую строку, если играть нечего —
 * тогда остаётся зашифрованный блоб, а если нет и его, показывать плеер
 * не нужно (см. canPlayVoice).
 */
export function voicePlaybackUri({ metaUri, isOutgoing, cid, gateway }: VoiceUriInput): string {
  // CID проверяется по форме в gatewayUrl: иначе чужие '../' и '?' уезжают в
  // адрес шлюза.
  const fromCid = gatewayUrl(gateway, cid);
  if (fromCid) return fromCid;
  // Outgoing rows can survive imports/restores and must not turn an arbitrary
  // stored URL into a beacon when the user taps play. The recorder only emits
  // app-local file URIs; legacy remote media should use its CID instead.
  if (isOutgoing && metaUri.startsWith('file://')) return metaUri;
  return '';
}

/** Есть ли вообще что играть: адрес или зашифрованный блоб. */
export function canPlayVoice(input: VoiceUriInput, hasBlob: boolean): boolean {
  return voicePlaybackUri(input).length > 0 || hasBlob;
}
