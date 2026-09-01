import { getIpfsClient, resetIpfsClient } from './node';
import { log } from '../../logger';

export type PubSubHandler = (msg: { data: Uint8Array; from?: string }) => void;

export async function pubsubSubscribe(
  topic: string,
  handler: PubSubHandler
): Promise<(() => void) | null> {
  try {
    const c = await getIpfsClient();
    if (!c) return null;
    await c.pubsub.subscribe(topic, (evt) => {
      try {
        const from =
          evt.type === 'signed' && 'from' in evt ? evt.from.toString() : undefined;
        handler({ data: evt.data, from });
      } catch (e) {
        log.warn('pubsub_handler_failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    });
    return () => {
      c.pubsub.unsubscribe(topic).catch(() => {
        /* ignore */
      });
    };
  } catch (e) {
    log.warn('pubsub_subscribe_failed', {
      err: e instanceof Error ? e.message : String(e),
      topic,
    });
    resetIpfsClient();
    return null;
  }
}

export async function pubsubPublish(topic: string, data: Uint8Array): Promise<boolean> {
  try {
    const c = await getIpfsClient();
    if (!c) return false;
    await c.pubsub.publish(topic, data);
    return true;
  } catch (e) {
    log.warn('pubsub_publish_failed', {
      err: e instanceof Error ? e.message : String(e),
      topic,
    });
    resetIpfsClient();
    return false;
  }
}
