// Azure AI Vision — multimodal image embeddings (Florence) voor cross-chain
// productmatching (0015_product_embeddings). Alleen de offline backfill
// (scripts/embed-product-images.mjs) praat met deze API; match-time is puur
// pgvector. Key/endpoint staan in Key Vault (VISION-API-KEY / VISION-ENDPOINT),
// gezet door deploy.ps1.
param env string
param location string

resource vision 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'vis-prakkie-${env}'
  location: location
  kind: 'ComputerVision'
  sku: {
    name: 'S1'
  }
  properties: {
    publicNetworkAccess: 'Enabled'
  }
}

output visionEndpoint string = vision.properties.endpoint
output visionName string = vision.name
