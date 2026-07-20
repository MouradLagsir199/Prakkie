// Tiny persistent key-value store (native: sqlite-backed; web fork: localStorage).
import KVStore from 'expo-sqlite/kv-store';

export const kv = {
  getItem: (key: string): Promise<string | null> => KVStore.getItemAsync(key),
  setItem: (key: string, value: string): Promise<void> => KVStore.setItemAsync(key, value),
  removeItem: async (key: string): Promise<void> => {
    await KVStore.removeItemAsync(key);
  },
};
