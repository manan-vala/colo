import { useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { SETTINGS_KEYS, SETTINGS_MAP, readPageSettings, type PageSettings } from "../../shared/doc-schema";

/**
 * Page settings live in the document's shared settings map (plan §3.3), so both people see a
 * change to page size, margins or headers at once. Defaults are never written: a missing key
 * means the default, so two people opening a new document never race to initialise it.
 */

interface SettingsStore {
  subscribe: (onChange: () => void) => () => void;
  snapshot: () => PageSettings;
}

const stores = new WeakMap<Y.Doc, SettingsStore>();

function storeFor(doc: Y.Doc): SettingsStore {
  let store = stores.get(doc);
  if (!store) {
    const settings = doc.getMap(SETTINGS_MAP);
    const listeners = new Set<() => void>();
    let cached: PageSettings | null = null;
    settings.observe(() => {
      cached = null;
      for (const listener of listeners) listener();
    });
    store = {
      subscribe: (onChange) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
      snapshot: () => (cached ??= readPageSettings((key) => settings.get(key))),
    };
    stores.set(doc, store);
  }
  return store;
}

export function usePageSettings(doc: Y.Doc): PageSettings {
  const store = storeFor(doc);
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

/** Writes only the settings that differ from the current ones, in one Yjs transaction. */
export function updatePageSettings(doc: Y.Doc, next: PageSettings) {
  const settings = doc.getMap(SETTINGS_MAP);
  const current = readPageSettings((key) => settings.get(key));
  doc.transact(() => {
    for (const key of Object.keys(next) as (keyof PageSettings)[]) {
      if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) settings.set(SETTINGS_KEYS[key], next[key]);
    }
  });
}
