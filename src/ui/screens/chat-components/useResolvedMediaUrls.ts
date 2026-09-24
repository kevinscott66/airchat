import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  isNbCid,
  parseNbCid,
  resolveBlobToLocalFileResult,
  type BlobResolveFailure,
  type BlobResolveResult,
} from '../../../core/media/mediaBlob';
import { gatewayUrl } from '../../../core/media/gatewayUrl';
// v4.32.359: счёт слотов переехал в core/utils/semaphore, а сам ограничитель —
// в core/media/mediaResolveLimit: он общий с разбором по требованию, иначе два
// предела по четыре дают восемь одновременных загрузок на один канал.
import { mediaResolveLimiter } from '../../../core/media/mediaResolveLimit';
import { log } from '../../../core/logger';
import { rawErrorText } from '../../components/userErrorText';

/**
 * v4.32.226: map mediaCids entries to displayable URIs. Plain IPFS cids map to
 * the gateway synchronously; `nb:` blob refs download+decrypt to a cached local
 * file (async — entry stays null until resolved, rendered as a placeholder).
 *
 * v4.32.243: адрес шлюза собирает core/media/gatewayUrl — CID приходит от
 * собеседника, а картинка грузится сама при отрисовке, поэтому '../' в «CID»
 * уводил загрузку на чужой сервер и выдавал IP-адрес получателя.
 */
/**
 * Что сейчас со снимком (v4.32.875).
 *
 * `pending` и `failed` раньше были одним и тем же `null`, и плитка рисовала
 * «📷 …» в обоих случаях — вечно. Снимок, который не скачался, выглядел ровно
 * как снимок, который качается прямо сейчас: ждать было нечего, а сказано об
 * этом не было ничего.
 */
export type MediaResolvePhase = 'pending' | 'ready' | 'failed';

export type MediaResolveSlot = {
  /** Адрес для `<Image>`; есть только у `ready`. */
  url: string | null;
  phase: MediaResolvePhase;
  /** Причина — только у `failed`; её показывает blobResolveText. */
  reason: BlobResolveFailure | null;
};

/** Начальное состояние слота: `nb:` качается, всё остальное решается сразу. */
function initialSlot(entry: string, gateway: string): MediaResolveSlot {
  if (isNbCid(entry)) return { url: null, phase: 'pending', reason: null };
  const url = gatewayUrl(gateway, entry) || '';
  // Адрес шлюза не собрался: CID кривой или шлюза нет вовсе. Появиться ему
  // неоткуда, поэтому ждать нечего — это отказ, а не загрузка.
  return url ? { url, phase: 'ready', reason: null } : { url: null, phase: 'failed', reason: 'unsupported' };
}

/**
 * Разбор вложений вместе с тем, чем он кончился, и повтором по требованию.
 *
 * Повтор общий на сообщение, а не на плитку: отказ почти всегда общий (сеть,
 * релей), а уже скачанное второй раз не качается — расшифрованный файл лежит
 * в кэше, и попытка стоит одной проверки его наличия.
 */
export function useResolvedMediaSlots(
  entries: string[],
  gateway: string,
): { slots: MediaResolveSlot[]; retry: () => void } {
  const key = entries.join('|');
  const [attempt, setAttempt] = useState(0);
  const [slots, setSlots] = useState<MediaResolveSlot[]>(() => entries.map((e) => initialSlot(e, gateway)));
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setSlots(entries.map((e) => initialSlot(e, gateway)));
    const put = (i: number, slot: MediaResolveSlot): void => {
      setSlots((prev) => {
        if (prev[i]?.url === slot.url && prev[i]?.phase === slot.phase) return prev;
        const next = [...prev];
        next[i] = slot;
        return next;
      });
    };
    entries.forEach((e, i) => {
      const ref = parseNbCid(e);
      if (!ref) return;
      // v4.32.625: отмена проверяется ВНУТРИ очереди, а не только на выходе.
      // Очередь общая на приложение и глубиной в сотни плиток («Общие медиа»),
      // слот отдаётся спустя минуты после постановки — и закрытая галерея
      // продолжала докачивать все свои вложения по 8 МБ до последнего.
      //
      // Отказ загрузки раньше глотался целиком (`.catch(() => null)`): плитка
      // остаётся серой и так, но отличить «сеть не отдала» от «ключ не подошёл»
      // было нельзя ничем, даже по журналу.
      const resolveOne = async (): Promise<BlobResolveResult | null> => {
        // null здесь — «уже не нужно», а не отказ: плитку закрытой галереи
        // помечать неудачей нельзя, её больше никто не видит.
        if (cancelled) return null;
        try {
          return await resolveBlobToLocalFileResult(ref, 'img');
        } catch (err) {
          log.warn('media_resolve_failed', {
            err: rawErrorText(err),
          });
          return { ok: false, reason: 'unknown' };
        }
      };
      void mediaResolveLimiter.run(resolveOne).then((res) => {
        if (cancelled || !res) return;
        put(i, res.ok
          ? { url: res.uri, phase: 'ready', reason: null }
          : { url: null, phase: 'failed', reason: res.reason });
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gateway, attempt]);
  return { slots, retry };
}

/**
 * Прежняя форма: только адреса.
 *
 * Оставлена для тех мест, где отказ и ожидание всё равно рисуются одинаково
 * (аватары, превью в списке общих медиа). Массив запоминается: он приходит в
 * зависимости эффектов у вызывающих, и новая ссылка на каждый рендер их бы
 * перезапускала.
 */
export function useResolvedMediaUrls(entries: string[], gateway: string): (string | null)[] {
  const { slots } = useResolvedMediaSlots(entries, gateway);
  return useMemo(() => slots.map((s) => s.url), [slots]);
}

/**
 * Тот же разбор для одиночного CID — аватар группы.
 *
 * v4.32.246: аватар грузился только по адресу шлюза, а на телефоне IPFS
 * выключен, поэтому единственный рабочий путь (`nb:`-вложение) не отображался
 * вовсе. Возвращает null, пока вложение не расшифровано, — вызывающий рисует
 * запасной кружок с буквой.
 */
export function useResolvedMediaUrl(cid: string | null | undefined, gateway: string): string | null {
  const entries = useMemo(() => (cid ? [cid] : []), [cid]);
  return useResolvedMediaUrls(entries, gateway)[0] ?? null;
}

/**
 * Адрес шлюза из настроек. Отдельный хук нужен там, где картинка появляется
 * в списке, у которого своего состояния для настроек нет, — список чатов.
 * Пустая строка до загрузки: `nb:`-вложения от неё не зависят.
 *
 * Значение запоминается в модуле: хук вызывается из каждой строки списка, и
 * без общего кэша открытие списка чатов означало бы отдельный асинхронный
 * запрос настроек и лишний перерисовывающий setState на каждый аватар.
 *
 * Смена шлюза в настройках подхватится после перезапуска приложения. Это
 * касается только старых CID «как есть»: зашифрованные вложения (`nb:`) от
 * шлюза не зависят вовсе, а публичные IPFS-шлюзы на телефоне и так мертвы
 * (см. transport/ipfs/heliaNode).
 */
let cachedGateway: string | null = null;

export function useIpfsGateway(): string {
  const [gateway, setGateway] = useState(cachedGateway ?? '');
  useEffect(() => {
    if (cachedGateway !== null) return;
    let alive = true;
    void import('../../../core/config')
      .then((m) => m.loadConfig())
      .then((c) => {
        cachedGateway = c.ipfs.gatewayUrl.replace(/\/$/, '');
        if (alive) setGateway(cachedGateway);
      })
      .catch(() => { /* останется пустым — покажем кружок с буквой */ });
    return () => { alive = false; };
  }, []);
  return gateway;
}
