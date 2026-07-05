// PostgreSQL Flexible Server per ADR-0001: B1ms, 32 GB, PG 16, HA off, PITR 7 d (plan/06_iac.md §3 #1)
param env string
param location string
// dev deviates from the {resource}-prakkie-{env} convention: the aborted westeurope create
// left a stale ARM name reservation on 'pg-prakkie-dev' (InvalidResourceLocation)
param serverName string = 'pg-prakkie-${env}'
param administratorLogin string = 'prakkieadmin'
@secure()
param administratorLoginPassword string
@description('Admin IP for direct psql access; empty = skip rule')
param adminIpAddress string = ''
param actionGroupId string

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource extensionsConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'VECTOR,PG_TRGM,UNACCENT,CITEXT'
    source: 'user-override'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'prakkie'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// "Allow Azure services" — the documented 0.0.0.0 sentinel rule
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServicesAndResources'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource allowAdminIp 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (adminIpAddress != '') {
  parent: postgres
  name: 'AdminWorkstation'
  properties: {
    startIpAddress: adminIpAddress
    endIpAddress: adminIpAddress
  }
}

// Burstable credits running out = imminent throttling (plan/06_iac.md §3 #12)
resource cpuCreditsAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-pg-cpu-credits-${env}'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [postgres.id]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT30M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'cpu_credits_remaining_low'
          metricName: 'cpu_credits_remaining'
          operator: 'LessThan'
          threshold: 50
          timeAggregation: 'Average'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}

resource storageAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-pg-storage-${env}'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [postgres.id]
    evaluationFrequency: 'PT1H'
    windowSize: 'PT1H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'storage_percent_high'
          metricName: 'storage_percent'
          operator: 'GreaterThan'
          threshold: 80
          timeAggregation: 'Average'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}

output serverName string = postgres.name
output fullyQualifiedDomainName string = postgres.properties.fullyQualifiedDomainName
