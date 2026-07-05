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
  pgUser: process.env.PG_USER ?? 'prakkie_ingest',
};
