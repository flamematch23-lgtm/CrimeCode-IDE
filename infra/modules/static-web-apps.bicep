targetScope = 'resourceGroup'

param location string = resourceGroup().location
param tags object = {}
param resourceSuffix string

resource console 'Microsoft.Web/staticSites@2022-09-01' = {
  name: 'swa-console-${resourceSuffix}'
  location: location
  tags: union(tags, { 'azd-service-name': 'console' })
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true
  }
}

resource docs 'Microsoft.Web/staticSites@2022-09-01' = {
  name: 'swa-docs-${resourceSuffix}'
  location: location
  tags: union(tags, { 'azd-service-name': 'docs' })
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true
  }
}

resource app 'Microsoft.Web/staticSites@2022-09-01' = {
  name: 'swa-app-${resourceSuffix}'
  location: location
  tags: union(tags, { 'azd-service-name': 'app' })
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true
  }
}

output consoleUrl string = 'https://${console.properties.defaultHostname}'
output docsUrl string = 'https://${docs.properties.defaultHostname}'
output appUrl string = 'https://${app.properties.defaultHostname}'
