// RG budget €50 with 50/80/100% actual + 100% forecast notifications (plan/06_iac.md §3 #11)
param env string
param ownerEmail string
param actionGroupId string
@description('Budget period start, first of current month, yyyy-MM-01')
param startDate string
param amount int = 50

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'budget-prakkie-${env}'
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    notifications: {
      actual50: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [ownerEmail]
        contactGroups: [actionGroupId]
      }
      actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [ownerEmail]
        contactGroups: [actionGroupId]
      }
      actual100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: [ownerEmail]
        contactGroups: [actionGroupId]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [ownerEmail]
        contactGroups: [actionGroupId]
      }
    }
  }
}
