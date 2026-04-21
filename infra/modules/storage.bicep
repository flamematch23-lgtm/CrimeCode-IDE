targetScope = 'resourceGroup'

param location string = resourceGroup().location
param tags object = {}
param resourceSuffix string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: replace('st${resourceSuffix}', '-', '')
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'uploads'
  properties: {
    publicAccess: 'None'
  }
}

resource redis 'Microsoft.Cache/Redis@2023-08-01' = {
  name: 'redis-${resourceSuffix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'Basic'
      family: 'C'
      capacity: 0
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
  }
}

output accountName string = storageAccount.name
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output redisCacheHostName string = redis.properties.hostName
output redisPort int = redis.properties.sslPort
output redisId string = redis.id
