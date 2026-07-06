import * as SecureStore from 'expo-secure-store';

/**
 * Session-token storage, platform-forked like kv.ts: hardware-backed
 * SecureStore on iOS/Android; see secure-tokens.web.ts for the web preview
 * (SecureStore does not exist on web — importing it there crashes ensureSession,
 * which the UI then misreads as "offline").
 */
export const getItemAsync = (key: string): Promise<string | null> => SecureStore.getItemAsync(key);
export const setItemAsync = (key: string, value: string): Promise<void> => SecureStore.setItemAsync(key, value);
export const deleteItemAsync = (key: string): Promise<void> => SecureStore.deleteItemAsync(key);
