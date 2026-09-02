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

  it('exposes media snapshots and cleans native streams with the call lifecycle', () => {
    expect(service).toContain('export function subscribeCallMedia');
    expect(service).toContain('export function getCallMediaStreams');
    expect(service).toContain('newPc.ontrack');
    expect(service).toContain('cleanupCallResources');
    expect(service).toContain('stopStream(oldLocalStream)');
    expect(service).toContain('stopStream(oldRemoteStream)');
  });
});
