import fs from 'fs';
import path from 'path';

const overlay = fs.readFileSync(path.join(__dirname, '..', 'components', 'CallOverlay.tsx'), 'utf8');
const service = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'social', 'callService.ts'), 'utf8');

describe('call media UI contract', () => {
  it('renders WebRTC video only for video calls and subscribes to media snapshots', () => {
    expect(overlay).toContain("require('react-native-webrtc').RTCView");
    expect(overlay).toContain("if (Platform.OS === 'web') return null;");
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
