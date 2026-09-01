import { useEffect, useMemo, useState } from 'react';
import { isNbCid, parseNbCid, resolveBlobToLocalFile } from '../../../core/media/mediaBlob';
import { gatewayUrl } from '../../../core/media/gatewayUrl';
// v4.32.359: счёт слотов переехал в core/utils/semaphore, а сам ограничитель —
// в core/media/mediaResolveLimit: он общий с разбором по требованию, иначе два
// предела по четыре дают восемь одновременных загрузок на один канал.
import { mediaResolveLimiter } from '../../../core/media/mediaResolveLimit';

/**
 * v4.32.226: map mediaCids entries to displayable URIs. Plain IPFS cids map to
 * the gateway synchronously; `nb:` blob refs download+decrypt to a cached local
 * file (async — entry stays null until resolved, rendered as a placeholder).
 *
 * v4.32.243: адрес шлюза собирает core/media/gatewayUrl — CID приходит от
 * собеседника, а картинка грузится сама при отрисовке, поэтому '../' в «CID»
 * уводил загрузку на чужой сервер и выдавал IP-адрес получателя.
 */
export function useResolvedMediaUrls(entries: string[], gateway: string): (string | null)[] {
  const key = entries.join('|');
  const [resolved, setResolved] = useState<(string | null)[]>(() =>
    entries.map((e) => (isNbCid(e) ? null : gatewayUrl(gateway, e) || null)),
  );
  useEffect(() => {
    let cancelled = false;
    setResolved(entries.map((e) => (isNbCid(e) ? null : gatewayUrl(gateway, e) || null)));
    entries.forEach((e, i) => {
      const ref = parseNbCid(e);
      if (!ref) return;
      void mediaResolveLimiter.run(() => resolveBlobToLocalFile(ref, 'img').catch(() => null)).then((local) => {
        if (cancelled || !local) return;
        setResolved((prev) => {
          if (prev[i] === local) return prev;
          const next = [...prev];
          next[i] = local;
          return next;
        });
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gateway]);
  return resolved;
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
