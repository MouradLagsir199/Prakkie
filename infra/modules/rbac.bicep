// RBAC for the Function apps' system-assigned identities (plan/06_iac.md §3 #4)
// Key Vault Secrets User + Storage Blob/Queue Data Contributor, stable guid() names, idempotent.
param keyVaultName string
param storageAccountName string
param principalIds array

var roleIds = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  storageQueueDataContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in principalIds: {
    name: guid(keyVault.id, principalId, roleIds.keyVaultSecretsUser)
    scope: keyVault
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultSecretsUser)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in principalIds: {
    name: guid(storage.id, principalId, roleIds.storageBlobDataContributor)
    scope: storage
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageBlobDataContributor)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource queueContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in principalIds: {
    name: guid(storage.id, principalId, roleIds.storageQueueDataContributor)
    scope: storage
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageQueueDataContributor)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]
