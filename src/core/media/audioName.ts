/**
 * audioName — «это музыкальный файл?» по имени вложения (v4.32.568).
 *
 * Раздел «Музыка» в карточке профиля отделён от «Файлов», а конверт документа
 * в переписке несёт только имя, размер и CID: типа содержимого (mime) в нём
 * нет и не было. Значит, единственное, на что можно опереться, — расширение
 * имени, и оно не истина, а догадка: файл `song.mp3` может оказаться чем
 * угодно. Поэтому раздел так и устроен — он отбирает то, что похоже на
 * музыку, и ничего не обещает про содержимое.
 *
 * Голосовые сюда не относятся: у них свой конверт (voiceEnvelope) и свой
 * раздел.
 */

const AUDIO_EXT = new Set([
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'alac',
]);

export function isAudioFileName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return AUDIO_EXT.has(name.slice(dot + 1).toLowerCase());
}
