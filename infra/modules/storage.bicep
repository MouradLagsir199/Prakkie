// Storage account: blob containers + lifecycle per plan/03_architecture.md §4, queues, db-backups immutability (plan/06_iac.md §3 #2)
param env string
param location string

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stprakkie${env}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

var containerNames = [
  'raw-snapshots'
  'images'
  'import-cache'
  'gdpr-exports'
  'db-backups' // index 4: referenced by dbBackupsImmutability — append new names at the end
  'deployments'
  'openfoodfacts' // OFF-parquet cache voor de ean-enrichment job
]

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for name in containerNames: {
    parent: blobService
    name: name
    properties: { publicAccess: 'None' }
  }
]

// Time-based immutability 30 d on db-backups (nightly dumps cannot be altered/deleted for 30 days)
resource dbBackupsImmutability 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = {
  parent: containers[4]
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: 30
    allowProtectedAppendWrites: true
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'raw-snapshots-cool-then-delete'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['raw-snapshots/'] }
            actions: {
              baseBlob: {
                tierToCool: { daysAfterModificationGreaterThan: 1 }
                delete: { daysAfterModificationGreaterThan: 90 }
              }
            }
          }
        }
        {
          name: 'raw-snapshots-html-30d'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['raw-snapshots/crawler-html/'] }
            actions: {
              baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } }
            }
          }
        }
        {
          name: 'import-cache-30d'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['import-cache/'] }
            actions: {
              baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } }
            }
          }
        }
        {
          name: 'gdpr-exports-7d'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['gdpr-exports/'] }
            actions: {
              baseBlob: { delete: { daysAfterModificationGreaterThan: 7 } }
            }
          }
        }
        {
          name: 'db-backups-nightly-35d'
          enabled: true
          type: 'Lifecycle'
          definition: {
            // nightly dumps deleted after the 30 d immutability window; monthly/ kept 12 mo
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['db-backups/nightly/'] }
            actions: {
              baseBlob: { delete: { daysAfterModificationGreaterThan: 35 } }
            }
          }
        }
        {
          name: 'db-backups-monthly-12mo'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['db-backups/monthly/'] }
            actions: {
              baseBlob: { delete: { daysAfterModificationGreaterThan: 366 } }
            }
          }
        }
      ]
    }
  }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

var queueNames = [
  'ingest-tasks'
  'crawl-tasks'
  'price-compute'
  'export-jobs'
  'import-jobs'
]

resource queues 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = [
  for name in queueNames: {
    parent: queueService
    name: name
  }
]

output storageAccountName string = storage.name
output storageAccountId string = storage.id
