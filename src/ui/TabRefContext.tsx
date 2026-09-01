// @stable  НЕ ИЗМЕНЯТЬ без явного запроса пользователя.
// Причина: v4.32.16 — ключевой механизм, через который keep-alive экраны узнают, активен ли
// их tab, БЕЗ re-render'а при смене tab. Prop `isActive` был удалён у всех 6 экранов — вместо
// него каждый экран читает `tabRef.current === 'feed'` в колбэках эффектов/подписок. Это даёт
// React.memo bail-out при `setTab(...)` (props экранов не меняются) → полное устранение 2.2с
// блока, который был re-render'ом GroupsScreen/FeedScreen на каждом таб-свитче.
//
// Паттерн:
//   // В App.tsx:
//   const tabRef = useRef<TabName>('feed');
//   tabRef.current = tab;  // синхронное обновление на каждом render App
//   <TabRefContext.Provider value={tabRef}>...  // value стабилен — consumers НЕ re-render'ятся
//
//   // В child-экране:
//   const tabRef = useTabRef();
//   useEffect(() => {
//     const unsub = subscribe(() => {
//       if (tabRef.current !== 'feed') return;  // gate — работа только когда tab активен
//       ...
//     });
//     return unsub;
//   }, [tabRef]);
//
// КРИТИЧНО: НИКОГДА не передавать `tabRef.current` как prop или в deps useEffect — это вернёт
// проблему re-render'а. Всегда читать `.current` ТОЛЬКО внутри колбэков / event handler'ов.
import React, { createContext, useContext, useRef } from 'react';
import type { MutableRefObject, ReactNode } from 'react';

/**
 * Табы нижней панели. Контактов среди них нет: с v4.32.30 список контактов
 * открывается из Профиля, а таб остался висеть скрытым — и был снят в v4.32.461.
 */
export type TabName = 'feed' | 'chat' | 'groups' | 'profile' | 'settings';

/** Default ref — используется только до первого Provider'а; в production всегда завёрнут в Provider. */
const defaultTabRef: MutableRefObject<TabName> = { current: 'feed' };

const TabRefContext = createContext<MutableRefObject<TabName>>(defaultTabRef);

/** Хук для чтения текущего таба из колбэков. НЕ вызывает re-render на смене таба. */
export function useTabRef(): MutableRefObject<TabName> {
  return useContext(TabRefContext);
}

type ProviderProps = {
  /** Текущий активный tab — обновляется на каждом render родителя. */
  tab: TabName;
  children: ReactNode;
};

/**
 * Provider, который экспонирует `tabRef` через Context. `tabRef` — это **стабильный ref-объект**,
 * который никогда не пересоздаётся (useRef). Поэтому `value={tabRef}` одинаков между render'ами,
 * и `useContext(TabRefContext)` НЕ вызывает re-render у consumer'ов при смене таба.
 *
 * Синхронно (не через useEffect) обновляем `tabRef.current = tab` — чтобы колбэки в subscribe'ах,
 * которые могут выстрелить сразу после setTab, уже видели свежий таб.
 */
export function TabRefProvider({ tab, children }: ProviderProps): React.ReactElement {
  const tabRef = useRef<TabName>(tab);
  tabRef.current = tab;  // синхронно каждый render
  return (
    <TabRefContext.Provider value={tabRef}>
      {children}
    </TabRefContext.Provider>
  );
}
