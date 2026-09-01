/**
 * Polyfill for browser Event/EventTarget APIs.
 * Required by @libp2p/* and other browser-targeting libraries running on Hermes/RN.
 */

if (typeof global.Event === 'undefined') {
  global.Event = class Event {
    constructor(type, init) {
      this.type = type;
      this.bubbles = (init && init.bubbles) || false;
      this.cancelable = (init && init.cancelable) || false;
      this.defaultPrevented = false;
      this.timeStamp = Date.now();
      this.target = null;
      this.currentTarget = null;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() {}
    stopImmediatePropagation() {}
  };
}

if (typeof global.EventTarget === 'undefined') {
  global.EventTarget = class EventTarget {
    constructor() {
      this._listeners = {};
    }
    addEventListener(type, listener) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(listener);
    }
    removeEventListener(type, listener) {
      if (!this._listeners[type]) return;
      this._listeners[type] = this._listeners[type].filter(l => l !== listener);
    }
    dispatchEvent(event) {
      const listeners = this._listeners[event.type] || [];
      event.target = this;
      listeners.forEach(l => l.call(this, event));
      return !event.defaultPrevented;
    }
  };
}

if (typeof global.CustomEvent === 'undefined') {
  global.CustomEvent = class CustomEvent extends global.Event {
    constructor(type, init) {
      super(type, init);
      this.detail = (init && init.detail) || null;
    }
  };
}
