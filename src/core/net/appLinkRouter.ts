/**
 * appLinkRouter — куда уходит НАША ссылка, нажатая внутри приложения.
 *
 * v4.32.606. Ссылку в тексте сообщения разбирает `core/text/entities`, а
 * открывает её `ui/utils/openExternal` — то есть система. Для чужого адреса это
 * верно, а для своего — нет: `https://<наш адрес>/l/post/…`, нажатая в
 * переписке, уводила человека в браузер, где ему предлагали поставить
 * приложение, уже стоящее у него на устройстве.
 *
 * Разорвать этот круг импортом нельзя: обработчик ссылок живёт в App.tsx —
 * ему нужны и вкладки, и состояние переходов, — а `openExternal` лежит ниже и
 * про экраны не знает. Поэтому здесь ровно одна ячейка: App.tsx кладёт в неё
 * свой обработчик на время жизни подписки, `openExternal` спрашивает её перед
 * тем, как отдать адрес системе.
 *
 * Пока обработчика нет (первые мгновения запуска, тесты, веб-сборка без
 * экранов) `routeAppLink` честно отвечает false, и ссылка уходит наружу, как
 * уходила раньше. Молчаливого проглатывания нажатия здесь быть не должно.
 */

import { isAppLink } from './appLink';

type AppLinkHandler = (url: string) => void;

let handler: AppLinkHandler | null = null;

/** Поставить обработчик. Снимать его при размонтировании обязательно. */
export function setAppLinkHandler(fn: AppLinkHandler | null): void {
  handler = fn;
}

/**
 * true — ссылка наша и уже отдана обработчику; наружу её отдавать не нужно.
 */
export function routeAppLink(raw: unknown): boolean {
  if (typeof raw !== 'string' || !isAppLink(raw)) return false;
  const fn = handler;
  if (!fn) return false;
  fn(raw);
  return true;
}
