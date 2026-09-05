import fs from 'fs';
import path from 'path';

const overlay = fs.readFileSync(path.join(__dirname, '..', 'components', 'CallOverlay.tsx'), 'utf8');
const service = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'social', 'callService.ts'), 'utf8');

describe('call media UI contract', () => {
  it('renders WebRTC video only for video calls and subscribes to media snapshots', () => {
    expect(overlay).toContain("require('react-native-webrtc').RTCView");
    // Раньше здесь проверялся безусловный выход по `Platform.OS === 'web'`.
    // Он стоял не потому, что в браузере не бывает видеозвонка, а потому, что
    // нативного `react-native-webrtc` там нет и require падал. С веб-портом
    // модуль на web подменяется на web/shims/react-native-webrtc.tsx, где
    // RTCView — это <video srcObject>, то есть настоящее видео; выход по
    // платформе стал бы отключением работающей возможности.
    //
    // Утверждение при этом не снято, а перенесено на то, чем оно было по
    // существу: загрузка модуля обязана быть защищённой. Проверяется отсутствие
    // модуля вообще (try/catch → null), а не имя платформы.
    //
    // Отрицания («в файле нет строки Platform.OS === 'web'») здесь намеренно
    // нет: разбора комментариев у этого теста, в отличие от paletteLiterals,
    // не заведено, и такое утверждение падало бы на объяснении, ПОЧЕМУ проверку
    // по платформе убрали. Утверждать надо наличие нужного, а не отсутствие
    // упоминания ненужного.
    expect(overlay).toMatch(/try \{[\s\S]*?require\('react-native-webrtc'\)[\s\S]*?\} catch \{[\s\S]*?return null;/);
    expect(overlay).toContain('subscribeCallMedia');
    expect(overlay).toContain('getCallMediaStreams');
    expect(overlay).toContain('call.isVideo ?');
    expect(overlay).toContain('streamURL={remoteUrl');
    expect(overlay).toContain('streamURL={localUrl');
  });

  it('keeps the expected video controls visible in the overlay contract', () => {
    expect(overlay).toContain('toggleMute');
    expect(overlay).toContain('toggleCamera');
    expect(overlay).toContain('switchCamera');
    expect(overlay).toContain('hasLocalVideoTrack');
    expect(overlay).toContain('camera-reverse');
    expect(overlay).toContain('Камера выключена');
    expect(overlay).toContain('remoteUrl');
    expect(overlay).toContain('localUrl');
  });

  // v4.32.587: оформление приведено к «жидкому стеклу». Проверяется не вид, а
  // те два условия, без которых стекло здесь либо нарисовано, либо небезопасно.
  it('стекло над чужим кадром не разбавляется, а над своим фоном — разбавляется', () => {
    // Над произвольным кадром единственная доказанная величина — `mediaScrim.bar`
    // (0.6 чёрного даёт белым чернилам 5.2:1 даже поверх белой фотографии).
    // Выводить прозрачность поверх неизвестного кадра нельзя, поэтому в ветке
    // `overMedia` заливка идёт как есть.
    expect(overlay).toContain('solid || overMedia ? fill : withAlpha(fill, glass.fill.prominent)');
    // Системное «уменьшить прозрачность» гасит размытие целиком — как в GlassSurface.
    expect(overlay).toContain('useReducedTransparency');
    expect(overlay).toContain('useReducedMotion');
  });

  it('подсветка лежит во всю страницу, а не внутри отступов', () => {
    // v4.32.588. Прежняя редакция этого теста утверждала только, что
    // `CallBackdrop` не стоит внутри `s.controls`. Утверждение было верным и
    // бесполезным: подсветка лежала внутри `s.audioStage`, у которого сверху
    // 56 точек паддинга родителя, а снизу панель кнопок, — SVG режется по
    // своему вьюпорту, и поперёк экрана шёл видимый шов. Тест этого не ловил.
    //
    // Проверяется то, что шов исключает: слой стоит прямо в `s.root`, у
    // которого отступов нет, и НЕ стоит ни в `s.container`, ни в `s.audioStage`.
    expect(overlay).toContain('root: { flex: 1 },');
    expect(overlay).toMatch(/<View style=\{\[s\.root,[\s\S]{0,400}?<CallBackdrop tone=\{tone\} wide=\{wide\} \/>[\s\S]{0,120}?<View style=\{\[s\.container,/);
    const at = overlay.indexOf('<View style={[s.container,');
    expect(at).toBeGreaterThan(0);
    const inner = overlay.slice(at, overlay.indexOf('</Modal>'));
    expect(inner).not.toContain('<CallBackdrop tone={tone} wide={wide} />');
  });

  it('границу подсветки держит геометрия, а не обрезка', () => {
    // Круглые кнопки берут порог графики 3:1 только на ровной заливке, поэтому
    // подсветка обязана кончаться выше них САМА. Числа и их обоснование живут
    // в `callWash` (themeContrast.test.ts меряет там же); здесь проверяется,
    // что разметка берёт их оттуда, а не повторяет литералами.
    expect(overlay).toContain('callWash');
    expect(overlay).toContain('stopOpacity={callWash.peakA}');
    expect(overlay).toContain('stopOpacity={callWash.peakB}');
    expect(overlay).toContain('const g = wide ? callWash.landscape : callWash.portrait;');
    expect(overlay).toContain('cy={`${g.a.cy}%`}');
    expect(overlay).toContain('cy={`${g.b.cy}%`}');
  });

  it('в широком окне экран звонка становится двумя колонками', () => {
    // v4.32.589. Столбик «аватар → имя → состояние → кнопки» рассчитан на
    // телефон в портрете. На iPad в альбоме, в окне браузера на MacBook и на
    // сайте в горизонтальном положении он стоит посреди пустоты, а по высоте
    // впритык. В широком окне контейнер разворачивается в строку.
    //
    // Раскладка выбирается по ОКНУ, а не по устройству: на сайте окно тянет
    // сам пользователь, и списка моделей здесь быть не может.
    expect(overlay).toContain('useWindowDimensions');
    expect(overlay).toContain('const wide = winW > winH && winW >= callLayout.wideMinWidth;');
    expect(overlay).toContain("containerWide: { flexDirection: 'row'");
    // Сцена в строке не должна распираться процентами — иначе она выдавит
    // колонку кнопок за экран.
    expect(overlay).toContain("stageWide: { width: 'auto', height: '100%' }");
    expect(overlay).toContain('wide && s.stageWide');
    // Ширина колонки — зажим из `callLayout`, а не литерал в разметке.
    expect(overlay).toContain('callLayout.controlsMax');
    expect(overlay).toContain('callLayout.controlsMin');
    expect(overlay).toContain('callLayout.controlsFraction');
    // Колонка не сжимается: иначе «принять» и «отклонить» перестанут
    // помещаться рядом.
    expect(overlay).toContain('controlsWide: { flexShrink: 0');
    // Подсветка знает про раскладку — в альбоме кнопки справа, и вертикальная
    // граница пятен там не защищает ничего.
    expect(overlay).toContain('<CallBackdrop tone={tone} wide={wide} />');
  });

  it('фазу звонка несут слова и набор кнопок, а не цвет фона', () => {
    // С 588-й фон одинаков во всех фазах (см. themeContrast.test.ts). Значит
    // единственное, что отличает идущий звонок от завершённого, — текст
    // состояния и то, какие кнопки показаны. Это требование WCAG 1.4.1, а не
    // оформление: убрать их нельзя.
    expect(overlay).toContain("'Подключение…'");
    expect(overlay).toContain("'Звонок завершён'");
    expect(overlay).toContain("'Входящий звонок…'");
    expect(overlay).toContain('formatClockDuration(elapsed)');
    expect(overlay).toContain('showCallControls');
    expect(overlay).toContain("isEnded ? 'close' : 'call'");
  });

  it('exposes media snapshots and cleans native streams with the call lifecycle', () => {
    expect(service).toContain('export function subscribeCallMedia');
    expect(service).toContain('export function getCallMediaStreams');
    expect(service).toContain('newPc.ontrack');
    expect(service).toContain('cleanupCallResources');
    expect(service).toContain('stopStream(oldLocalStream)');
    expect(service).toContain('stopStream(oldRemoteStream)');
  });
});
