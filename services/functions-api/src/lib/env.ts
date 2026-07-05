/** Runtime config — app settings in Azure (infra/modules/functions.bicep), local.settings.json locally. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required app setting ${name}`);
  return value;
}

export const env = {
  get pgHost() {
    return required('PG_HOST');
  },
  get pgPassword() {
    return required('PG_PASSWORD');
  },
  pgDatabase: process.env.PG_DATABASE ?? 'prakkie',
  pgUser: process.env.PG_USER ?? 'prakkie_app',
  get jwtSigningKey() {
    return required('JWT_SIGNING_KEY');
  },
  /** Empty until owner input #4 lands — Apple/Google sign-in returns 501 without them. */
  appleClientIds: (process.env.APPLE_CLIENT_IDS ?? '').split(',').filter(Boolean),
  googleClientIds: (process.env.GOOGLE_CLIENT_IDS ?? '').split(',').filter(Boolean),
};
