// Static Web App Free: web reader + landing + /bot page (plan/06_iac.md §3 #9)
param env string
param location string

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'stapp-prakkie-${env}'
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
  }
}

output staticWebAppName string = staticWebApp.name
output defaultHostname string = staticWebApp.properties.defaultHostname
