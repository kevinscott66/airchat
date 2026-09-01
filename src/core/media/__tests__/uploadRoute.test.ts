import {
  chooseUploadRoute,
  uploadLimitBytes,
  formatLimit,
  IPFS_VIDEO_MAX_BYTES,
  IPFS_DOC_MAX_BYTES,
} from '../uploadRoute';
import { MAX_BLOB_BYTES } from '../blobRef';

describe('uploadLimitBytes', () => {
  it('без IPFS предел один — потолок вложения', () => {
    expect(uploadLimitBytes({ ipfsEnabled: false })).toBe(MAX_BLOB_BYTES);
  });

  it('без IPFS вид вложения предела не меняет', () => {
    // Ровно эта развилка и путалась по экранам: «видео 25 МБ» писали и там,
    // где IPFS выключен, а уезжало оно вложением с потолком 8 МБ.
    expect(uploadLimitBytes({ ipfsEnabled: false, ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES })).toBe(MAX_BLOB_BYTES);
  });

  it('с IPFS берётся потолок вида вложения', () => {
    expect(uploadLimitBytes({ ipfsEnabled: true, ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES })).toBe(IPFS_VIDEO_MAX_BYTES);
  });

  it('с IPFS без указанного вида — документный потолок', () => {
    expect(uploadLimitBytes({ ipfsEnabled: true })).toBe(IPFS_DOC_MAX_BYTES);
  });

  it('негодный потолок вида не проходит', () => {
    expect(uploadLimitBytes({ ipfsEnabled: true, ipfsMaxBytes: NaN })).toBe(IPFS_DOC_MAX_BYTES);
    expect(uploadLimitBytes({ ipfsEnabled: true, ipfsMaxBytes: -1 })).toBe(IPFS_DOC_MAX_BYTES);
  });
});

describe('chooseUploadRoute', () => {
  it('без IPFS файл в пределах — путь вложения', () => {
    expect(chooseUploadRoute({ sizeBytes: 1_000_000, ipfsEnabled: false })).toEqual({
      kind: 'blob',
      limitBytes: MAX_BLOB_BYTES,
    });
  });

  it('с IPFS файл в пределах — путь IPFS', () => {
    expect(chooseUploadRoute({ sizeBytes: 1_000_000, ipfsEnabled: true }).kind).toBe('ipfs');
  });

  it('файл ровно по пределу проходит', () => {
    expect(chooseUploadRoute({ sizeBytes: MAX_BLOB_BYTES, ipfsEnabled: false }).kind).toBe('blob');
  });

  it('файл на байт больше предела отвергается', () => {
    expect(chooseUploadRoute({ sizeBytes: MAX_BLOB_BYTES + 1, ipfsEnabled: false })).toEqual({
      kind: 'reject',
      limitBytes: MAX_BLOB_BYTES,
    });
  });

  it('видео на 20 МБ: с IPFS проходит, без него — нет', () => {
    const size = 20_000_000;
    expect(chooseUploadRoute({ sizeBytes: size, ipfsEnabled: true, ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES }).kind).toBe('ipfs');
    expect(chooseUploadRoute({ sizeBytes: size, ipfsEnabled: false, ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES }).kind).toBe('reject');
  });

  it('отказ несёт предел, по которому принят', () => {
    // Число уходит в текст ошибки: раньше оно писалось руками и разъезжалось
    // с проверкой — экран обещал «8 МБ» там, где предел был 50.
    const r = chooseUploadRoute({ sizeBytes: 99_000_000, ipfsEnabled: true, ipfsMaxBytes: IPFS_DOC_MAX_BYTES });
    expect(r).toEqual({ kind: 'reject', limitBytes: IPFS_DOC_MAX_BYTES });
  });

  describe('неизвестный размер', () => {
    // Галерея сообщает размер не всегда, и это не повод ни отказать, ни
    // прочитать файл целиком: путь выбирается, а размер спросит mediaUpload.
    it('не задан — путь выбирается', () => {
      expect(chooseUploadRoute({ ipfsEnabled: false }).kind).toBe('blob');
    });

    it('null — путь выбирается', () => {
      expect(chooseUploadRoute({ sizeBytes: null, ipfsEnabled: false }).kind).toBe('blob');
    });

    it('NaN не считается разрешением и не считается отказом', () => {
      expect(chooseUploadRoute({ sizeBytes: NaN, ipfsEnabled: false }).kind).toBe('blob');
    });

    it('Infinity не проходит как «в пределах»', () => {
      // Бесконечность бывает у stat на недоступном файле; принять её за
      // валидный размер значило бы либо пропустить что угодно, либо отвергнуть
      // всё. Здесь она отбрасывается как неизвестный размер.
      expect(chooseUploadRoute({ sizeBytes: Infinity, ipfsEnabled: false }).kind).toBe('blob');
    });

    it('отрицательный размер отбрасывается', () => {
      expect(chooseUploadRoute({ sizeBytes: -5, ipfsEnabled: false }).kind).toBe('blob');
    });
  });

  it('пустой файл путь не выбирает заранее — отказ даёт загрузка', () => {
    // Ноль — валидный размер и не превышает предел; отсеять пустышку должен
    // тот, кто читает, иначе «файл недоступен» стало бы «файл слишком большой».
    expect(chooseUploadRoute({ sizeBytes: 0, ipfsEnabled: false }).kind).toBe('blob');
  });
});

describe('formatLimit', () => {
  it('потолок вложения — 8 МБ', () => {
    expect(formatLimit(MAX_BLOB_BYTES)).toBe('8 МБ');
  });

  it('потолок видео — 25 МБ', () => {
    expect(formatLimit(IPFS_VIDEO_MAX_BYTES)).toBe('25 МБ');
  });

  it('потолок документа — 50 МБ', () => {
    expect(formatLimit(IPFS_DOC_MAX_BYTES)).toBe('50 МБ');
  });

  it('нецелый предел округляется вниз', () => {
    // Вверх нельзя: подпись обещала бы больше, чем пропустит проверка.
    expect(formatLimit(1_570_000)).toBe('1.5 МБ');
  });
});
