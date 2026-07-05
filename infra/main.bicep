// Prakkie infrastructure — subscription scope so the RG itself is IaC-managed (plan/06_iac.md §2)
// Deploy: az deployment sub create --location westeurope --template-file main.bicep --parameters main.<env>.bicepparam
targetScope = 'subscription'

@allowed(['dev', 'prod'])
param env string
param location string = 'westeurope'
// This subscription offer is LocationIsOfferRestricted for PG Flexible Server in westeurope;
// Postgres gets its own location (northeurope = same EU geo, ~<10 ms from westeurope)
param pgLocation string = 'northeurope'
@description('Override when the default name is blocked by a stale ARM reservation')
param pgServerName string = 'pg-prakkie-{env}'
param ownerEmail string
@secure()
param pgAdminPassword string
@description('Admin IP for direct psql access; empty = no rule')
param adminIpAddress string = ''
param utcMonth string = utcNow('yyyy-MM')

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'prakkie-${env}'
  location: location
}

module monitoring 'modules/monitoring.bicep' = {
  scope: rg
  name: 'monitoring'
  params: {
    env: env
    location: location
    ownerEmail: ownerEmail
  }
}

module storage 'modules/storage.bicep' = {
  scope: rg
  name: 'storage'
  params: {
    env: env
    location: location
  }
}

module keyvault 'modules/keyvault.bicep' = {
  scope: rg
  name: 'keyvault'
  params: {
    env: env
    location: location
  }
}

module postgres 'modules/postgres.bicep' = {
  scope: rg
  name: 'postgres'
  params: {
    env: env
    location: pgLocation
    serverName: replace(pgServerName, '{env}', env)
    administratorLoginPassword: pgAdminPassword
    adminIpAddress: adminIpAddress
    actionGroupId: monitoring.outputs.actionGroupId
  }
}

module functionsApi 'modules/functions.bicep' = {
  scope: rg
  name: 'functions-api'
  params: {
    env: env
    location: location
    role: 'api'
    storageAccountName: storage.outputs.storageAccountName
    keyVaultName: keyvault.outputs.keyVaultName
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
  }
}

module functionsIngest 'modules/functions.bicep' = {
  scope: rg
  name: 'functions-ingest'
  params: {
    env: env
    location: location
    role: 'ingest'
    storageAccountName: storage.outputs.storageAccountName
    keyVaultName: keyvault.outputs.keyVaultName
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
  }
}

module rbac 'modules/rbac.bicep' = {
  scope: rg
  name: 'rbac'
  params: {
    keyVaultName: keyvault.outputs.keyVaultName
    storageAccountName: storage.outputs.storageAccountName
    principalIds: [
      functionsApi.outputs.principalId
      functionsIngest.outputs.principalId
    ]
  }
}

module staticWebApp 'modules/staticwebapp.bicep' = {
  scope: rg
  name: 'staticwebapp'
  params: {
    env: env
    location: location
  }
}

module budget 'modules/budget.bicep' = {
  scope: rg
  name: 'budget'
  params: {
    env: env
    ownerEmail: ownerEmail
    actionGroupId: monitoring.outputs.actionGroupId
    startDate: '${utcMonth}-01'
  }
}

output resourceGroupName string = rg.name
output apiFunctionAppName string = functionsApi.outputs.functionAppName
output ingestFunctionAppName string = functionsIngest.outputs.functionAppName
output keyVaultName string = keyvault.outputs.keyVaultName
output pgFqdn string = postgres.outputs.fullyQualifiedDomainName
output staticWebAppHostname string = staticWebApp.outputs.defaultHostname
