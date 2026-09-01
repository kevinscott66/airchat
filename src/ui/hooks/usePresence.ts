import { useEffect, useState } from 'react';
import {
  getPresenceState,
  subscribePresence,
  type PresenceState,
} from '../../core/social/presenceService';

/**
 * Реактивный хук: возвращает PresenceState для пира и обновляется при изменении.
 */
export function usePresence(peerPubB64: string): PresenceState {
  const [state, setState] = useState<PresenceState>(() =>
    peerPubB64 ? getPresenceState(peerPubB64) : { bucket: 'never', lastActiveAt: 0, label: '', status: '' }
  );

  useEffect(() => {
    if (!peerPubB64) return;
    setState(getPresenceState(peerPubB64));
    const unsub = subscribePresence((peer, s) => {
      if (peer === peerPubB64) setState(s);
    });
    return unsub;
  }, [peerPubB64]);

  return state;
}
