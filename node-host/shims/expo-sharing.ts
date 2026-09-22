/**
 * Node-замена `expo-sharing`.
 *
 * «Поделиться» — это системный лист выбора приложения; без графической сессии
 * его некому показать и некуда отправить. `isAvailableAsync` отвечает `false`
 * честно, и это важнее отказа в `shareAsync`: `cacheFiles` спрашивает
 * доступность заранее и при отрицательном ответе просто не предлагает
 * действие. То есть правильная ветка в ядре уже написана — надо лишь в неё
 * попасть.
 */
export async function isAvailableAsync(): Promise<boolean> {
  return false;
}

export async function shareAsync(): Promise<void> {
  throw new Error('sharing_unavailable_on_node: shareAsync');
}

export default { isAvailableAsync, shareAsync };
