/**
 * v4.32.568: раздел «Музыка» в карточке профиля отбирает вложения по имени
 * файла — конверт документа в переписке несёт только имя, размер и cid, типа
 * содержимого в нём нет. Значит, ошибка разбора имени не «портит подпись», а
 * уводит файл не в тот раздел: договор ляжет в музыку, а трек — в файлы.
 */
import { isAudioFileName } from '../audioName';

describe('isAudioFileName', () => {
  it('узнаёт распространённые звуковые расширения', () => {
    for (const n of ['track.mp3', 'song.m4a', 'rec.wav', 'live.flac', 'note.opus']) {
      expect(isAudioFileName(n)).toBe(true);
    }
  });

  it('регистр расширения роли не играет — файлы приходят с чужих устройств', () => {
    expect(isAudioFileName('TRACK.MP3')).toBe(true);
    expect(isAudioFileName('Song.M4A')).toBe(true);
  });

  it('не забирает документы в музыку', () => {
    for (const n of ['договор.pdf', 'смета.xlsx', 'фото.jpg', 'архив.zip']) {
      expect(isAudioFileName(n)).toBe(false);
    }
  });

  it('имя без расширения музыкой не считается', () => {
    expect(isAudioFileName('mp3')).toBe(false);
    expect(isAudioFileName('запись')).toBe(false);
    expect(isAudioFileName('')).toBe(false);
  });

  it('точка в конце и ведущая точка не дают расширения', () => {
    expect(isAudioFileName('track.')).toBe(false);
    // Ведущая точка по общему правилу — признак скрытого файла, а не
    // расширения: у «.mp3» имени нет вовсе, и в музыку он не идёт.
    expect(isAudioFileName('.mp3')).toBe(false);
  });

  it('смотрит на последнее расширение, а не на любое встреченное', () => {
    expect(isAudioFileName('mp3.pdf')).toBe(false);
    expect(isAudioFileName('запись.mp3.zip')).toBe(false);
    expect(isAudioFileName('альбом.2024.flac')).toBe(true);
  });
});
