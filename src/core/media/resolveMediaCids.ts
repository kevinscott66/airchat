import { gatewayUrl } from './gatewayUrl';
import { mediaResolveLimiter } from './mediaResolveLimit';
import { parseMediaCidsColumn } from './mediaCidPolicy';
import { parseNbCid, resolveBlobToLocalFile } from './mediaBlob';

export type ResolvedMedia = {
  /** Готовые к показу адреса, в порядке колонки. */
  uris: string[];
  /** Сколько записей колонки адресом не стали. */
  missing: number;
};

/**
 * Разовый разбор колонки media_cids в готовые для показа адреса.
 *
 * v4.32.248. То же, что делает хук useResolvedMediaUrls при отрисовке, но по
 * требованию: одноразовое фото открывается по нажатию, и держать его
 * расшифрованным всё время, пока пузырь на экране, незачем — снимок обещан «на
 * один раз».
 *
 * Обычный CID превращается в адрес шлюза (форма проверяется в gatewayUrl:
 * «CID» вида '../' уводит загрузку на чужой сервер), `nb:`-дескриптор
 * расшифровывается в файл кэша.
 *
 * v4.32.359. Две правки, и обе про то, что вызывающий этим списком РАСПОРЯЖАЕТСЯ
 * судьбой сообщения:
 *
 * — Число несостоявшихся адресов теперь возвращается. Раньше негодные записи
 *   просто отпадали, и вызывающий не мог отличить «показали всё» от «показали
 *   половину». А показав половину, он удалял сообщение целиком — вместе с
 *   единственной ссылкой на неоткрытые снимки.
 *
 * — Вложения расшифровываются параллельно, через общий на приложение
 *   ограничитель. Последовательно это была очередь загрузок по 30 секунд
 *   таймаута каждая: у одноразового сообщения из десяти снимков нажатие
 *   оборачивалось минутами пустого экрана.
 */
export async function resolveMediaCidsToUris(
  mediaCids: string | null | undefined,
  gateway: string | null | undefined
): Promise<ResolvedMedia> {
  const cids = parseMediaCidsColumn(mediaCids);
  // Порядок колонки — это порядок, в котором снимки отправляли; просмотрщик
  // открывается по индексу, поэтому результат складывается по местам, а не по
  // времени готовности.
  const slots: Array<string | null> = new Array(cids.length).fill(null);

  await Promise.all(
    cids.map(async (cid, i) => {
      const ref = parseNbCid(cid);
      if (!ref) {
        slots[i] = gatewayUrl(gateway, cid) || null;
        return;
      }
      slots[i] = await mediaResolveLimiter
        .run(() => resolveBlobToLocalFile(ref, 'img'))
        .catch(() => null);
    })
  );

  const uris = slots.filter((u): u is string => u !== null);
  return { uris, missing: cids.length - uris.length };
}
