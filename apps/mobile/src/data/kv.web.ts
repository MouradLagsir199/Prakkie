// Web fork: expo-sqlite (wasm) stays out of the web bundle; localStorage is plenty.
export const kv = {
  getItem: async (key: string): Promise<string | null> => globalThis.localStorage?.getItem(key) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    globalThis.localStorage?.setItem(key, value);
  },
};
