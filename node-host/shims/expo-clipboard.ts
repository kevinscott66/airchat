/**
 * Node-замена `expo-clipboard`. Граница платформы, а не отложенная работа.
 *
 * Буфер обмена принадлежит графической сессии, и у процесса без неё его нет —
 * ни системного, ни своего. Единственный потребитель в ядре,
 * `clipboardSecret`, кладёт туда секрет и через время стирает; выполнить
 * половину этого (положить и не стереть) было бы хуже, чем не делать ничего.
 *
 * Отсюда громкий отказ, а не пустая строка: пустая строка притворилась бы
 * успешным чтением пустого буфера, и вызывающий решил бы, что копировать было
 * нечего.
 */
function refuse(api: string): never {
  throw new Error(`clipboard_unavailable_on_node: ${api}`);
}

export async function getStringAsync(): Promise<string> {
  return refuse('getStringAsync');
}

export async function setStringAsync(): Promise<boolean> {
  return refuse('setStringAsync');
}

export async function hasStringAsync(): Promise<boolean> {
  return false;
}

export default { getStringAsync, setStringAsync, hasStringAsync };
