// OFF→EAN verrijking (owner-plan 2026-07-14): ACR + Container Apps environment
// + geplande job die services/ean-enrichment draait.
//   OFF parquet → blob (stprakkie<env>/openfoodfacts) → NL-filter → match
//   Aldi/PLUS + ontbrekende AH-EAN's → catalog.products.ean (pg-prakkie-<env>)
// De job gebruikt een user-assigned identity zodat KV-secret-ref, AcrPull en
// blob-toegang binnen één deployment vóór de job zelf bestaan (een system-
// assigned identity bestaat pas ná de job en laat de KV-validatie stuklopen).
// NB: AAD-propagatie van verse role assignments kan enkele minuten achterlopen;
// een her-run van de deploy lost een eenmalige validatiefout op.
param env string
param location string
@description('Container Apps environment + job location. Kept separate from `location`: AKS (which backs Container Apps) has hit regional capacity limits on westeurope before — see ManagedEnvironmentCapacityHeavyUsageError. ACR/identity stay in `location`; only the environment + job move.')
param containerAppsLocation string = location
param keyVaultName string
param storageAccountName string
param pgHost string
param logAnalyticsName string
@description('Door deploy.ps1 op het echte ACR-image gezet; de placeholder houdt de eerste infra-deploy groen (image bestaat dan nog niet).')
param jobImage string = 'mcr.microsoft.com/k8se/quickstart-jobs:latest'

var roleIds = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-ean-enrich-${env}'
  location: location
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'crprakkie${env}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, roleIds.keyVaultSecretsUser)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultSecretsUser)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, roleIds.storageBlobDataContributor)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageBlobDataContributor)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, roleIds.acrPull)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.acrPull)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-prakkie-${env}'
  location: containerAppsLocation
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-ean-enrich-${env}'
  location: containerAppsLocation
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnv.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: '0 3 * * 1' // maandag 03:00 UTC — ná de weekend-crawls
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 7200
      replicaRetryLimit: 1
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'pg-password'
          keyVaultUrl: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/PG-INGEST-PASSWORD'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'ean-enrichment'
          image: jobImage
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'PG_HOST', value: pgHost }
            { name: 'PG_DATABASE', value: 'prakkie' }
            { name: 'PG_USER', value: 'prakkie_ingest' }
            { name: 'PG_PASSWORD', secretRef: 'pg-password' }
            { name: 'STORAGE_ACCOUNT', value: storageAccountName }
            { name: 'ENRICH_CHAINS', value: 'aldi,plus,ah' }
            // DefaultAzureCredential moet wéten welke identity (er is alleen een UAMI)
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
          ]
        }
      ]
    }
  }
  dependsOn: [
    kvSecretsUser
    acrPull
  ]
}

output jobName string = job.name
output registryLoginServer string = acr.properties.loginServer
output registryName string = acr.name
