/**
 * Дефект. Пузырь GIF грузил картинку с серверов Tenor всегда: `GifBubble`
 * (ui/components/GifPicker.tsx) отдавал `<Image source={{ uri }} />` сразу,
 * не спрашивая «Автозагрузку медиа». Настройку эту слушались снимки,
 * документы и голосовые — через `useAutoDownloadGate`, — а GIF мимо неё
 * проходил. Выбор «Никогда» в настройках на GIF не действовал вовсе.
 *
 * Цена. У GIF она выше, чем у своего вложения: своё лежит зашифрованным в
 * нашем хранилище, а здесь устройство само, без единого нажатия, идёт на
 * чужой сервер (Tenor — это Google) и отдаёт ему свой IP-адрес и точное
 * время, когда переписку открыли. Запустить это может любой собеседник —
 * достаточно прислать GIF; отметки о прочтении при этом могут быть
 * выключены, а весь остальной трафик идти через туннель. Обратим внимание:
 * подставить ЧУЖОЙ адрес нельзя с v4.32.240 (`gifEnvelope` пропускает
 * только tenor.com), так что выдать себя отправителю этим уже не выйдет —
 * речь о третьей стороне, которой человек ничего не посылал.
 *
 * Правка. `GifBubble` спрашивает тот же `useAutoDownloadGate`, что и
 * остальные пузыри, и при запрете рисует нажимаемую заглушку «GIF —
 * нажмите, чтобы загрузить». Нажатие грузит, как и раньше.
 *
 * Границы. Проверка по исходникам: `GifBubble` — компонент с хуками, а
 * @testing-library/react-native в сборке нет. Пиньоны стоят на том, что
 * решение принимается ДО `<Image>`, иначе запрет опять «делал бы вид», как
 * это уже было с MediaStrip до v4.32.248.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const PICKER = read('src/ui/components/GifPicker.tsx');
const GATE = read('src/ui/screens/chat-components/useAutoDownloadGate.ts');

/** Тело `GifBubble` — от объявления до следующего верхнеуровневого `const`. */
function bubbleBody(src: string): string {
  const from = src.indexOf('export function GifBubble(');
  expect(from).toBeGreaterThan(0);
  const to = src.indexOf('\nconst gb = StyleSheet.create(', from);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe('GIF слушается «Автозагрузки медиа» (v4.32.939)', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: пузырь и настройка на месте', () => {
    expect(PICKER).toContain('export function GifBubble(');
    expect(GATE).toContain("kvGet('auto_download_media')");
    expect(GATE).toContain('export function useAutoDownloadGate()');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: пузырь по-прежнему ходит на чужой сервер', () => {
    // Картинка грузится по адресу из сообщения — то есть сетевой поход
    // никуда не делся, он лишь стал спрашиваться. Если однажды GIF начнут
    // складывать к себе, эта проверка упадёт и потребует переписать саму
    // постановку задачи, а не подкрутить ожидание.
    expect(bubbleBody(PICKER)).toContain('source={{ uri: url }}');
  });

  it('решение принимается до того, как картинка пойдёт грузиться', () => {
    const body = bubbleBody(PICKER);
    expect(body).toContain('const gated = useAutoDownloadGate();');
    const gate = body.indexOf('if (gated && !wanted)');
    const image = body.indexOf('source={{ uri: url }}');
    expect(gate).toBeGreaterThan(0);
    expect(image).toBeGreaterThan(gate);
  });

  it('негодный адрес разбирается раньше запрета', () => {
    // По адресу, не прошедшему gifEnvelope, не ходят ни при какой настройке.
    // Предложить там «нажмите, чтобы загрузить» значило бы обещать то, чего
    // не будет: нажатие ничего не откроет.
    const body = bubbleBody(PICKER);
    const bad = body.indexOf('if (!url || errored)');
    const gate = body.indexOf('if (gated && !wanted)');
    expect(bad).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(bad);
  });

  it('заглушка нажимается и называется', () => {
    const body = bubbleBody(PICKER);
    expect(body).toContain('onPress={() => setWanted(true)}');
    expect(body).toContain('accessibilityRole="button"');
    expect(body).toContain('GIF — нажмите, чтобы загрузить');
  });

  it('хук берётся общий, свой второй не заведён', () => {
    expect(PICKER).toContain(
      "import { useAutoDownloadGate } from '../screens/chat-components/useAutoDownloadGate';"
    );
    expect(PICKER).not.toContain("kvGet('auto_download_media')");
  });
});
