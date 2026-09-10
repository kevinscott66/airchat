/**
 * Новая сторис — одна страница (v4.32.691).
 *
 * До этой версии создание сторис начиналось с системного `Alert.alert` со
 * списком «Текст / Фото / Видео», и каждый пункт открывал СВОЙ редактор.
 * Отсюда три следствия, и все три пользователь видел:
 *
 *   • тип выбирался вслепую, до первого экрана, и передумать можно было
 *     только через «Отмена» и второй заход;
 *   • набранная подпись пропадала при смене типа — состояние у редакторов
 *     было своё;
 *   • системный лист поверх приложения не знал ни темы, ни стекла.
 *
 * Здесь проверяется форма исходника: экранного стыка у этих трёх утверждений
 * нет (модалка не монтируется в jest — тянет expo-video, expo-image-picker и
 * нативный blur), а общий у них — текст. Каждая проверка ниже держится
 * положительным контролем: сначала доказывается, что файл на месте и это тот
 * самый файл, и лишь потом — что нужной формы в нём нет.
 */
import fs from 'fs';
import path from 'path';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');
/** Тот же файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('{/*'))
    .join('\n');
const count = (s: string, needle: string): number => s.split(needle).length - 1;

const ROW = (): string => bare('components/StoriesRow.tsx');
const COMP = (): string => bare('components/StoryComposerModal.tsx');
const GLASS = (): string => bare('components/GlassSurface.tsx');

it('ПРОВЕРКА НЕ ПУСТАЯ: все три файла на месте и это те самые файлы', () => {
  expect(ROW()).toContain('export function StoriesRow(');
  expect(ROW().length).toBeGreaterThan(20_000);
  expect(COMP()).toContain('export function StoryComposerModal(');
  expect(COMP().length).toBeGreaterThan(5_000);
  expect(GLASS()).toContain('export function GlassSurface(');
});

it('тип сторис больше не спрашивается системным листом до первого экрана', () => {
  const s = ROW();
  // ПОВОД ДЛЯ ПРАВКИ ЖИВ: полоса по-прежнему умеет открывать редактор.
  expect(s).toContain('const createStory = useCallback(() => { setComposerVisible(true); }, []);');
  expect(s).not.toContain("Alert.alert('Новая сторис'");
  expect(s).not.toContain('📝 Текст');
  expect(s).not.toContain('🖼 Фото');
  expect(s).not.toContain('🎬 Видео');
  // Прочие листы полосы (меню сторис, просмотры) остались — вырезка не пустая.
  expect(count(s, 'Alert.alert(')).toBeGreaterThan(0);
});

it('редактор один, и все три типа переключаются внутри него', () => {
  const s = COMP();
  expect(s).toContain("type Mode = 'text' | 'photo' | 'video';");
  for (const id of ["id: 'text'", "id: 'photo'", "id: 'video'"]) expect(s).toContain(id);
  // Переключатель — часть страницы, а не отдельный шаг: у пунктов роль вкладки
  // и озвученное состояние, иначе VoiceOver прочитает три одинаковые кнопки.
  expect(s).toContain('accessibilityRole="tab"');
  expect(s).toContain('accessibilityState={{ selected: active }}');
  expect(count(s, 'onPress={() => setMode(m.id)}')).toBe(1);
});

it('текст один на все режимы, а выбранные фото и видео — каждое своё', () => {
  const s = COMP();
  // Один state текста на оба поля: именно его теряла прежняя пара редакторов.
  expect(count(s, 'const [text, setText] = useState')).toBe(1);
  expect(count(s, 'value={text}')).toBe(2);
  expect(count(s, 'onChangeText={setText}')).toBe(2);
  // Общий предел длины: два разных обрезали бы текст молча при переключении.
  expect(count(s, 'maxLength={MAX_STORY_TEXT}')).toBe(2);
  expect(count(s, 'const MAX_STORY_TEXT =')).toBe(1);
  // Отдельные ячейки под фото и видео: уход в другой режим и обратно не
  // должен стирать уже выбранный файл.
  expect(s).toContain('const [photoUri, setPhotoUri] = useState<string | null>(null);');
  expect(s).toContain('const [videoUri, setVideoUri] = useState<string | null>(null);');
  expect(s).toContain(
    "const mediaUri = mode === 'video' ? videoUri : mode === 'photo' ? photoUri : null;"
  );
});

it('стекло редактора тёмное принудительно, а чернила поверх кадра — из mediaScrim', () => {
  const s = COMP();
  // BlurView внутри GlassSurface — ребёнок, то есть ложится ПОВЕРХ заливки
  // контейнера. Светлый tint осветлил бы плашку, которую здесь просят сделать
  // тёмной ради контраста подписи над чужой фотографией.
  expect(count(s, '<GlassSurface')).toBe(count(s, 'tone="dark"'));
  expect(count(s, '<GlassSurface')).toBeGreaterThanOrEqual(4);
  expect(s).not.toContain("tone='auto'");
  // Над кадром фон неизвестен, и белым «на глаз» здесь не пишут.
  expect(s).toContain('mediaScrim.ink');
  expect(s).toContain('mediaScrim.inkMuted');
  // На известном фоне текстовой сторис чернила считаются от него.
  expect(s).toContain('const textInk = inkOn(darkColors, textBg);');
  expect(s).toContain('const textPlateInk = inkOn(darkColors, textPlate);');
});

it('признак tone у стекла и вправду подменяет палитру, а не только tint', () => {
  const s = GLASS();
  expect(s).toContain("tone = 'auto',");
  expect(s).toContain("const colors = tone === 'dark' ? darkColors : themeColors;");
  // Палитра тёмная → isLight ложно → tint тёмный: отдельной ветки не нужно,
  // и лишней быть не должно, иначе tint и заливка разойдутся.
  expect(s).toContain("const tint = isLight ? 'light' : 'dark';");
  expect(count(s, 'const tint =')).toBe(1);
});

it('геометрия редактора — только токены, вписанных чисел нет', () => {
  const s = COMP();
  expect(s.match(/fontSize:\s*\d/)).toBeNull();
  expect(s.match(/borderRadius:\s*\d/)).toBeNull();
  // ПОВОД ДЛЯ ПРАВКИ ЖИВ: числа там действительно нужны и берутся из темы.
  expect(s).toContain('fontSize: font.');
  expect(s).toContain('borderRadius: radius.');
  // Нажимаемое не мельче пальца.
  expect(s).toContain('minHeight: TOUCH_TARGET_MIN');
  // Отступы от краёв — у системы, а не вписанные 48 и 40, как было в полосе.
  expect(s).toContain('const insets = useSafeAreaInsets();');
  expect(s).toContain('insets.top');
  expect(s).toContain('insets.bottom');
});
