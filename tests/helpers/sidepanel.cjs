'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const JSZip = require('../../jszip.min.js');

const root = path.resolve(__dirname, '../..');

async function createSidepanel({ saved = {}, handlers = {} } = {}) {
  const { window, document } = parseHTML(fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8'));
  const storage = structuredClone(saved);
  const calls = { messages: [], storageWrites: [], downloads: [], clipboard: [], tabs: [], network: [], logs: [] };
  const timerErrors = [];
  const timers = new Set();
  const objectUrls = new Map();
  const messageListeners = [];
  let nextObjectUrl = 0;

  // Advance asynchronous UI timers without waiting for presentation delays.
  // Chrome API callbacks remain microtasks, before request timeout callbacks.
  function fastTimeout(callback, delay, ...args) {
    const handle = setImmediate(() => {
      timers.delete(handle);
      try { callback(...args); } catch (error) { timerErrors.push(error); }
    });
    timers.add(handle);
    return handle;
  }
  function cancelTimer(handle) {
    clearImmediate(handle);
    timers.delete(handle);
  }
  function callbackOrPromise(value, callback) {
    const result = Promise.resolve(value);
    if (callback) result.then(callback);
    return result;
  }
  class FixtureURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:subbatch-test/${++nextObjectUrl}`;
      objectUrls.set(url, blob);
      return url;
    }
    static revokeObjectURL(url) { objectUrls.delete(url); }
  }

  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (relative) => `chrome-extension://subbatch-test/${relative}`,
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      sendMessage(message, callback) {
        calls.messages.push(structuredClone(message));
        let response;
        if (handlers[message.action]) {
          response = handlers[message.action](message, calls);
        } else if (message.action === 'setCookie') {
          storage.bilibiliCookie = message.cookie;
          response = { success: true };
        } else {
          throw new Error(`Unhandled extension message in fixture: ${message.action}`);
        }
        return callbackOrPromise(response, callback);
      },
    },
    storage: {
      local: {
        get(keys, callback) {
          const selected = {};
          for (const key of typeof keys === 'string' ? [keys] : keys) {
            if (Object.hasOwn(storage, key)) selected[key] = structuredClone(storage[key]);
          }
          return callbackOrPromise(selected, callback);
        },
        set(values, callback) {
          calls.storageWrites.push(structuredClone(values));
          Object.assign(storage, structuredClone(values));
          return callbackOrPromise(undefined, callback);
        },
      },
    },
    tabs: {
      query: async () => [],
      create(options, callback) {
        calls.tabs.push(structuredClone(options));
        return callbackOrPromise({ id: calls.tabs.length, ...options }, callback);
      },
    },
    downloads: {
      download(options, callback) {
        const blob = objectUrls.get(options.url);
        if (!blob) throw new Error('Download does not reference a generated Blob');
        calls.downloads.push({ ...options, blob });
        return callbackOrPromise(calls.downloads.length, callback);
      },
    },
  };
  const consoleFixture = Object.fromEntries(
    ['log', 'warn', 'error', 'info', 'debug', 'time', 'timeEnd'].map((level) => [
      level,
      (...args) => calls.logs.push({ level, args }),
    ]),
  );
  const navigator = { clipboard: { writeText: async (text) => calls.clipboard.push(text) } };
  const context = vm.createContext({
    window, document, chrome, navigator, console: consoleFixture, JSZip,
    URL: FixtureURL, URLSearchParams, Blob, TextEncoder, TextDecoder,
    performance, structuredClone,
    setTimeout: fastTimeout, clearTimeout: cancelTimer,
    requestAnimationFrame: (callback) => fastTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: cancelTimer,
    fetch: async (...args) => {
      calls.network.push(args);
      throw new Error('Live network access is disabled in the sidepanel fixture');
    },
  });
  window.open = (url) => calls.tabs.push({ url });
  window.innerWidth = 1000;
  window.innerHeight = 800;
  // linkedom supplies DOM events/HTML parsing; application source is unchanged.
  new vm.Script(fs.readFileSync(path.join(root, 'script.js'), 'utf8'), {
    filename: 'script.js',
  }).runInContext(context);
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  async function settle(predicate = () => true, label = 'sidepanel state') {
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise(setImmediate);
      if (timerErrors.length) throw timerErrors[0];
      if (predicate()) return;
    }
    const errors = calls.logs.filter((entry) => entry.level === 'error').map((entry) => entry.args.join(' '));
    throw new Error(`Timed out waiting for ${label}. Application errors: ${errors.join('; ')}`);
  }
  function find(selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Sidepanel element not found: ${selector}`);
    return element;
  }
  async function click(selector) {
    find(selector).dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await settle();
  }
  async function fill(selector, value, eventName = 'input') {
    const element = find(selector);
    element.value = value;
    element.dispatchEvent(new window.Event(eventName, { bubbles: true }));
    await settle();
  }
  await settle();
  return {
    window, document, context, storage, calls, find, click, fill, settle,
    dispose() { for (const handle of timers) cancelTimer(handle); },
  };
}

module.exports = { createSidepanel };
