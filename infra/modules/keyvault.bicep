// Key Vault Standard, RBAC mode, soft-delete + purge protection (plan/06_iac.md §3 #3)
param env string
param location string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-prakkie-${env}'
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled' // no private endpoints per budget (ADR-0001 posture)
  }
}

output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
