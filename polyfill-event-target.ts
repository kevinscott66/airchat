/**
 * Must be the first side-effect import in the app entry: ES modules run all imports
 * before the entry body, so assignments in index.ts ran too late for Hermes + RN deps.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
// @ts-ignore
import { Event, EventTarget } from 'event-target-shim';

const g = globalThis as unknown as Record<string, unknown>;
if (g.Event == null) {
  g.Event = Event;
}
if (g.EventTarget == null) {
  g.EventTarget = EventTarget;
}
