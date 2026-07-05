// One Linux Consumption Function app (invoked twice: api + ingest, ADR-0003; plan/06_iac.md §3 #5)
param env string
param location string
@allowed(['api', 'ingest'])
param role string
param storageAccountName string
param keyVaultName string
param appInsightsConnectionString string
param pgHost string

var appName = 'func-prakkie-${role}-${env}'
// KV secret names per plan/06_iac.md §3 #3: PG-APP-PASSWORD (api app) / PG-INGEST-PASSWORD
var pgSecretName = role == 'api' ? 'PG-APP-PASSWORD' : 'PG-INGEST-PASSWORD'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-prakkie-${role}-${env}'
  location: location
  kind: 'linux'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'AzureWebJobsStorage', value: storageConnectionString }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
        { name: 'PRAKKIE_ENV', value: env }
        { name: 'KEY_VAULT_NAME', value: keyVaultName }
        // Separate Durable task hub per app (ADR-0003); also used by host.json via %TASK_HUB_NAME%
        { name: 'TASK_HUB_NAME', value: 'prakkie${role}${env}' }
        { name: 'PG_HOST', value: pgHost }
        { name: 'PG_DATABASE', value: 'prakkie' }
        { name: 'PG_USER', value: role == 'api' ? 'prakkie_app' : 'prakkie_ingest' }
        // KV references resolve at runtime once scripts/deploy has seeded the secrets
        { name: 'JWT_SIGNING_KEY', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=JWT-SIGNING-KEY)' }
        { name: 'PG_PASSWORD', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=${pgSecretName})' }
        // import pipeline (WS3) — server-side only, never reachable from the client
        { name: 'APIFY_API_TOKEN', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=APIFY-API-TOKEN)' }
        { name: 'OPENAI_API_KEY', value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=OPENAI-API-KEY)' }
      ]
    }
  }
}

output functionAppName string = functionApp.name
output principalId string = functionApp.identity.principalId
