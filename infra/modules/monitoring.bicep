// Log Analytics + workspace-based App Insights + owner action group (plan/06_iac.md §3 #6-8, #10)
param env string
param location string
param ownerEmail string

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-prakkie-${env}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-prakkie-${env}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-prakkie-${env}'
  location: 'global'
  properties: {
    groupShortName: 'prakkie-${env}'
    enabled: true
    emailReceivers: [
      {
        name: 'owner'
        emailAddress: ownerEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

output logAnalyticsId string = logAnalytics.id
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output actionGroupId string = actionGroup.id
