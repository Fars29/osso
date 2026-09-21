/**
 * A minimal `chrome.*` stand-in for unit tests: storage.local backed by a Map, runtime messaging
 * that tests can wire up, and no-op action/badge. Modules under test never touch the network.
 */
import { vi } from "vitest";

type Listener = (...args: unknown[]) => unknown;

export function installChromeMock() {
  const store = new Map<string, unknown>();
  const messageListeners: Listener[] = [];
  const changedListeners: Listener[] = [];

  const chromeMock = {
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
          if (keys == null) return Object.fromEntries(store);
          const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out: Record<string, unknown> = {};
          for (const k of list) if (store.has(k)) out[k] = store.get(k);
          if (!Array.isArray(keys) && typeof keys === "object") for (const [k, v] of Object.entries(keys)) if (!(k in out)) out[k] = v;
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          const changes: Record<string, { oldValue?: unknown; newValue: unknown }> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store.get(k), newValue: v };
            store.set(k, v);
          }
          for (const l of changedListeners) l(changes, "local");
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of typeof keys === "string" ? [keys] : keys) store.delete(k);
        }),
        clear: vi.fn(async () => store.clear()),
        getBytesInUse: vi.fn(async () => 0),
      },
      onChanged: { addListener: (l: Listener) => changedListeners.push(l), removeListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: (l: Listener) => messageListeners.push(l), removeListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      openOptionsPage: vi.fn(async () => undefined),
      lastError: undefined as undefined | { message: string },
      getURL: (p: string) => `chrome-extension://osso/${p}`,
      id: "osso",
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: "https://example.com/", active: true }]),
      sendMessage: vi.fn(async () => undefined),
      create: vi.fn(async () => ({ id: 2 })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setBadgeTextColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    commands: { onCommand: { addListener: vi.fn() } },
    __store: store,
    __messageListeners: messageListeners,
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  return chromeMock;
}

installChromeMock();
