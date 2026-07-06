/**
 * Web fork of secure-tokens: localStorage-backed. Fine for the dev/companion
 * web preview — tokens are short-lived (15-min access + rotating refresh) and
 * the web build talks to the dev API. Native builds keep hardware-backed
 * SecureStore via secure-tokens.ts.
 */
const k = (key: string) => `prakkie.secure:${key}`;

export async function getItemAsync(key: string): Promise<string | null> {
  return globalThis.localStorage?.getItem(k(key)) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  globalThis.localStorage?.setItem(k(key), value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  globalThis.localStorage?.removeItem(k(key));
}
