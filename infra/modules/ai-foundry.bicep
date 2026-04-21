targetScope = 'resourceGroup'

param location string = resourceGroup().location
param tags object = {}
param resourceSuffix string

resource account 'Microsoft.CognitiveServices/accounts@2025-04-01-preview' = {
  name: 'oai-${resourceSuffix}'
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: 'oai-${resourceSuffix}'
    publicNetworkAccess: 'Enabled'
  }
}

resource gpt4oDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = {
  parent: account
  name: 'gpt-4o'
  sku: {
    name: 'Standard'
    capacity: 10
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-4o'
      version: '2024-11-20'
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

resource gpt4Deployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = {
  parent: account
  name: 'gpt-4'
  dependsOn: [gpt4oDeployment]
  sku: {
    name: 'Standard'
    capacity: 10
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-4'
      version: 'turbo-2024-04-09'
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

output endpoint string = account.properties.endpoint
output name string = account.name
output id string = account.id
