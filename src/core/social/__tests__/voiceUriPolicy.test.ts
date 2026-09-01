/**
 * Адрес голосового сообщения: чужой uri к плееру не попадает.
 */

import { canPlayVoice, voicePlaybackUri } from '../voiceUriPolicy';

const GW = 'https://ipfs.example';
const CID = 'a'.repeat(46);

describe('voicePlaybackUri', () => {
  it('CID со шлюзом побеждает всё остальное', () => {
    expect(voicePlaybackUri({ metaUri: 'file:///own.m4a', isOutgoing: true, cid: CID, gateway: GW }))
      .toBe(`${GW}/ipfs/${CID}`);
    expect(voicePlaybackUri({ metaUri: 'file:///peer.m4a', isOutgoing: false, cid: CID, gateway: `${GW}/` }))
      .toBe(`${GW}/ipfs/${CID}`);
  });

  it('своя запись играется по локальному пути', () => {
    expect(voicePlaybackUri({ metaUri: 'file:///own.m4a', isOutgoing: true })).toBe('file:///own.m4a');
  });

  it('чужой uri не отдаётся плееру ни в каком виде', () => {
    for (const metaUri of [
      'file:///data/user/0/com.anonymous.airchat/secret.m4a',
      'content://media/external/audio/1',
      'data:audio/mp4;base64,AAAA',
      'http://beacon.example/a.mp3',
      'https://beacon.example/a.mp3',
      'ipfs://' + CID,
      'javascript:alert(1)',
    ]) {
      expect(voicePlaybackUri({ metaUri, isOutgoing: false })).toBe('');
      expect(voicePlaybackUri({ metaUri, isOutgoing: false, gateway: GW })).toBe('');
    }
  });

  it('битый CID от собеседника не склеивается в адрес шлюза', () => {
    for (const cid of ['../../../etc/passwd', `${CID}?redirect=evil`, `${CID}/../x`, 'evil.com/x', '']) {
      expect(voicePlaybackUri({ metaUri: 'file:///peer.m4a', isOutgoing: false, cid, gateway: GW })).toBe('');
    }
  });

  it('битый CID у своего сообщения откатывается на локальный путь, а не на мусорный адрес', () => {
    expect(voicePlaybackUri({ metaUri: 'file:///own.m4a', isOutgoing: true, cid: '../x', gateway: GW }))
      .toBe('file:///own.m4a');
  });

  it('исходящий URL не открывается как маяк без проверенного CID', () => {
    expect(voicePlaybackUri({ metaUri: 'https://beacon.example/voice.m4a', isOutgoing: true })).toBe('');
    expect(voicePlaybackUri({ metaUri: 'content://external/audio/1', isOutgoing: true })).toBe('');
  });

  it('без шлюза или со странным шлюзом CID не используется', () => {
    for (const gateway of [undefined, null, '', '   ', 'javascript:', 'ftp://x']) {
      expect(voicePlaybackUri({ metaUri: 'file:///peer.m4a', isOutgoing: false, cid: CID, gateway })).toBe('');
    }
  });
});

describe('canPlayVoice', () => {
  it('нечего играть — плеер не нужен', () => {
    expect(canPlayVoice({ metaUri: 'https://beacon.example/a.mp3', isOutgoing: false }, false)).toBe(false);
  });

  it('зашифрованный блоб — играть есть что даже без адреса', () => {
    expect(canPlayVoice({ metaUri: 'file:///peer.m4a', isOutgoing: false }, true)).toBe(true);
  });

  it('свой файл или CID — играть есть что', () => {
    expect(canPlayVoice({ metaUri: 'file:///own.m4a', isOutgoing: true }, false)).toBe(true);
    expect(canPlayVoice({ metaUri: '', isOutgoing: false, cid: CID, gateway: GW }, false)).toBe(true);
  });
});
