/**
 * Почему не удалось узнать место — и что человеку с этим делать.
 *
 * Измеренный дефект (v4.32.543). Координаты у устройства спрашивали в четырёх
 * местах: `deviceLocation.readCurrentPosition` (живая геолокация) и ещё три
 * раза руками — в переписке, в группе и в ленте. Три рукописных вызова
 * повторяли одни и те же три строки (динамический импорт, запрос разрешения,
 * `getCurrentPositionAsync`) и расходились ровно в том, чего человек не видит:
 *
 *   • Переписка. Ни одного catch. `getCurrentPositionAsync` бросает, когда
 *     геолокация в телефоне выключена — на Android это
 *     `E_LOCATION_SERVICES_DISABLED`, а сообщение звучит как «Location
 *     provider is unavailable». Отказ уходил необработанным отклонением
 *     промиса: человек нажимал «отправить местоположение», и не происходило
 *     ровно ничего. Ни точки на карте, ни ошибки. Кнопка выглядела сломанной,
 *     хотя чинится она одним переключателем в шторке.
 *   • Группа. Один catch на всё: и на поиск места, и на запись в базу, и на
 *     рассылку. Любая из трёх бед показывала «Не удалось отправить
 *     геопозицию» — текст, из которого не следует ни одного действия.
 *   • Лента. Один catch, один текст «Не удалось определить геолокацию» на все
 *     причины сразу.
 *
 * Ни в одном из четырёх мест не было срока ожидания. В помещении приёмник
 * ищет спутники минутами, и всё это время экран молчит точно так же, как при
 * выключенной геолокации: «ищем» и «сломано» неотличимы.
 *
 * Разбор причины — чистая работа со строкой, и именно она решает, что человек
 * прочтёт: «включите геолокацию в настройках» или «выйдите к окну». Разные
 * подсказки для разных причин — единственное, ради чего этот разбор нужен;
 * одинаковый текст на все случаи можно было бы и не писать.
 *
 * Модуль намеренно без единого импорта: его зовут и `deviceLocation`, и три
 * экрана, и он не должен тянуть за собой ни expo-location, ни журнал.
 */

/** Причина отказа, различимая по коду или тексту ошибки. */
export type LocationFailureKind = 'denied' | 'disabled' | 'timeout' | 'unavailable' | 'unknown';

/**
 * Сколько ждём ответа приёмника, прежде чем сказать человеку, что сигнала
 * нет. Двадцать секунд — это заметно дольше обычного «холодного» старта GPS
 * на улице (5–10 с) и заметно короче того, что человек готов смотреть на
 * неподвижный экран, ничего о нём не понимая.
 */
export const LOCATION_FIX_TIMEOUT_MS = 20_000;

/** Опознаватель нашего собственного отказа по сроку — разбирается ниже. */
export const LOCATION_TIMEOUT_CODE = 'E_LOCATION_TIMEOUT';

/**
 * Текст ошибки из чего угодно.
 *
 * Ошибки expo-location несут код отдельным полем (`code`), а человекочитаемое
 * описание — в `message`; смотреть надо на оба, потому что на iOS код бывает
 * пустым, а на Android — наоборот, описание общее на несколько причин.
 */
function textOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw === null || raw === undefined) return '';
  const box = raw as { code?: unknown; message?: unknown };
  const parts: string[] = [];
  if (typeof box.code === 'string') parts.push(box.code);
  if (typeof box.message === 'string') parts.push(box.message);
  return parts.length > 0 ? parts.join(' ') : String(raw);
}

/**
 * Причина отказа по коду или тексту ошибки.
 *
 * Порядок проверок значим и не переставляется:
 *   1. Свой срок ожидания — единственная причина, которую придумали мы сами.
 *   2. Разрешение — про него говорят и `E_NO_PERMISSIONS`, и `denied`.
 *   3. Выключенная геолокация. Здесь же живёт андроидное «location provider
 *      is unavailable»: слово «unavailable» в нём есть, но чинится оно
 *      переключателем, а не повторной попыткой, — поэтому проверка стоит
 *      ВЫШЕ общего «unavailable», иначе человек получил бы «попробуйте ещё
 *      раз» на ситуацию, в которой повтор не поможет никогда.
 *   4. Приёмник есть, места нет.
 */
export function classifyLocationFailure(raw: unknown): LocationFailureKind {
  const text = textOf(raw).toLowerCase();
  if (text.trim().length === 0) return 'unknown';
  if (text.includes('location_timeout') || text.includes('timed out') || text.includes('timeout')) {
    return 'timeout';
  }
  if (text.includes('permission') || text.includes('no_permissions') || text.includes('denied')) {
    return 'denied';
  }
  if (
    text.includes('services_disabled')
    || text.includes('services are disabled')
    || text.includes('services are not enabled')
    || text.includes('settings_unsatisfied')
    || text.includes('provider is unavailable')
  ) {
    return 'disabled';
  }
  if (text.includes('unavailable') || text.includes('no location')) return 'unavailable';
  return 'unknown';
}

/** Что показать человеку. Каждый текст называет следующее действие. */
export function locationFailureText(kind: LocationFailureKind): string {
  switch (kind) {
    case 'denied':
      return 'Нет доступа к геолокации. Разрешите его в настройках приложения.';
    case 'disabled':
      return 'Геолокация выключена. Включите её в настройках телефона и попробуйте снова.';
    case 'timeout':
      return 'Не удалось поймать сигнал. У окна или на улице это получается быстрее.';
    case 'unavailable':
      return 'Устройство не смогло определить место. Попробуйте ещё раз.';
    default:
      return 'Не удалось определить местоположение.';
  }
}

/** Короткий путь для мест, где на руках только сама ошибка. */
export function locationFailureTextFor(raw: unknown): string {
  return locationFailureText(classifyLocationFailure(raw));
}

/**
 * Тот же промис, но с сроком ожидания.
 *
 * Отменить сам запрос к приёмнику нечем — у expo-location нет ни сигнала
 * отмены, ни отзыва. Поэтому здесь именно срок на ОЖИДАНИЕ: работа внизу
 * может закончиться и позже, её ответ просто больше никому не нужен. Важно,
 * что обработчик на неё навешивается в любом случае, — иначе опоздавший отказ
 * стал бы необработанным отклонением промиса и уронил бы разработческую
 * сборку через несколько секунд после того, как человеку уже всё показали.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  code: string = LOCATION_TIMEOUT_CODE,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(code));
    }, ms);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
