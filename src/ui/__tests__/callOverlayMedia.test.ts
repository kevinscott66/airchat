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

  it('подсветка фона не заходит под круглые кнопки', () => {
    // Фон идущего звонка выведен из того же зелёного, что кнопка «принять», и
    // подходит к порогу графики 3:1 впритык: осветление под кнопками уводит их
    // за порог уже при непрозрачности 0.10 (замер в themeContrast.test.ts).
    // Поэтому подсветка живёт внутри сцены, а область действий остаётся на
    // ровной заливке — это утверждение о вёрстке, а не о вкусе.
    const actions = overlay.slice(overlay.indexOf('<View style={s.controls}>'));
    expect(actions).not.toContain('CallBackdrop');
    expect(overlay).toContain('<CallBackdrop');
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
