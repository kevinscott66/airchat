/**
 * presencePolicy — кто видит время последнего входа.
 *
 * v4.32.238. До этой версии настройка «Последний визит» была почти
 * декоративной:
 *  - вариант «Контакты» ничем не отличался от «Все» (признано в комментарии
 *    самого presenceService);
 *  - единственная проверка стояла в publish через IPFS pubsub, а на телефоне
 *    `isIpfsEnabled()` возвращает false, и этот код не выполняется вообще;
 *  - «был(а) в сети» на самом деле вычисляет ПОЛУЧАТЕЛЬ по входящему трафику
 *    (recordPeerActivity), поэтому даже «Никто» ни на что не влияло.
 *
 * Починить это можно только двумя половинами, и обе живут здесь:
 *  1. исходящая — собеседнику отправляется уже посчитанное решение
 *     «показывать меня или нет», и честный клиент его исполняет;
 *  2. входящая — взаимность: скрывая своё время, человек не видит и чужое.
 *     Эта половина работает независимо от того, что делает чужой клиент.
 *
 * Модуль без импортов: правило проверяется тестами, а не читается глазами.
 */

export type LastSeenVisibility = 'everybody' | 'contacts' | 'nobody';

/** Значение из kv; всё неизвестное — «Все» (так работало до появления настройки). */
export function parseLastSeenVisibility(raw: string | null | undefined): LastSeenVisibility {
  return raw === 'nobody' || raw === 'contacts' || raw === 'everybody' ? raw : 'everybody';
}

/**
 * Что отправить конкретному собеседнику: показывать ему моё время или нет.
 *
 * Решение считается ЗДЕСЬ, у отправителя, а не у получателя — только здесь
 * известно, контакт он мне или нет. Получателю уходит уже готовое «да/нет»,
 * иначе «Контакты» было бы невыполнимым: чужой клиент не знает, есть ли он в
 * моей адресной книге.
 */
export function shouldShareLastSeenWith(params: {
  visibility: LastSeenVisibility;
  isContact: boolean;
}): boolean {
  if (params.visibility === 'nobody') return false;
  if (params.visibility === 'contacts') return params.isContact;
  return true;
}

/**
 * Показывать ли мне время последнего входа собеседника.
 *
 * `peerAllows === false` — он попросил не отмечать его (исполняем).
 * `myVisibility === 'nobody'` — взаимность: спрятав своё время, я не вижу
 * чужого. Без этого настройка «Никто» оставалась бы односторонней выгодой и
 * не значила бы ничего для того, кто её включил.
 */
export function canSeePeerLastSeen(params: {
  peerAllows: boolean | undefined;
  myVisibility: LastSeenVisibility;
}): boolean {
  if (params.peerAllows === false) return false;
  return params.myVisibility !== 'nobody';
}
