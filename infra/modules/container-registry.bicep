targetScope = 'resourceGroup'

param location string = resourceGroup().location
param tags object = {}
param resourceSuffix string

var name = replace('cr${resourceSuffix}', '-', '')

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: true
    publicNetworkAccess: 'Enabled'
  }
}

output loginServer string = registry.properties.loginServer
output name string = registry.name
output id string = registry.id
