targetScope = 'resourceGroup'

param location string = resourceGroup().location
param tags object = {}
param resourceSuffix string
param logAnalyticsCustomerId string
param logAnalyticsPrimarySharedKey string
param containerRegistryLoginServer string
param containerRegistryName string
param keyVaultName string
param openAIEndpoint string
param mysqlHost string
param storageAccountName string
param redisCacheHostName string
param appInsightsConnectionString string

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${resourceSuffix}'
  location: location
  tags: tags
}

resource env 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: 'cae-${resourceSuffix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsPrimarySharedKey
      }
    }
  }
}

resource opencodeServer 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'ca-opencode-${resourceSuffix}'
  location: location
  tags: union(tags, { 'azd-service-name': 'opencode-server' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    environmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 4096
        transport: 'auto'
      }
      secrets: [
        {
          name: 'server-password'
          value: uniqueString(resourceGroup().id, 'opencode-server-password')
        }
      ]
      registries: [
        {
          server: containerRegistryLoginServer
          identity: managedIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'opencode-server'
          image: '${containerRegistryLoginServer}/opencode-server:latest'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'AZURE_CLIENT_ID', value: managedIdentity.properties.clientId }
            { name: 'AZURE_OPENAI_ENDPOINT', value: openAIEndpoint }
            { name: 'AZURE_RESOURCE_NAME', value: split(split(openAIEndpoint, '//')[1], '.')[0] }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'OPENCODE_SERVER_PASSWORD', secretRef: 'server-password' }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 10
        rules: [
          {
            name: 'http-scaling'
            http: { metadata: { concurrentRequests: '50' } }
          }
        ]
      }
    }
  }
}

resource apiWorker 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'ca-api-${resourceSuffix}'
  location: location
  tags: union(tags, { 'azd-service-name': 'api' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    environmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        stickySessions: { affinity: 'sticky' }
      }
      registries: [
        {
          server: containerRegistryLoginServer
          identity: managedIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${containerRegistryLoginServer}/api:latest'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'AZURE_CLIENT_ID', value: managedIdentity.properties.clientId }
            { name: 'MYSQL_HOST', value: mysqlHost }
            { name: 'MYSQL_DATABASE', value: 'crimecode' }
            { name: 'STORAGE_ACCOUNT_NAME', value: storageAccountName }
            { name: 'REDIS_HOST', value: redisCacheHostName }
            { name: 'OPENCODE_SERVER_URL', value: 'https://${opencodeServer.properties.configuration.ingress.fqdn}' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 20
        rules: [
          {
            name: 'http-scaling'
            http: { metadata: { concurrentRequests: '100' } }
          }
        ]
      }
    }
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, managedIdentity.id, '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  scope: containerRegistry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output opencodeServerUrl string = 'https://${opencodeServer.properties.configuration.ingress.fqdn}'
output apiUrl string = 'https://${apiWorker.properties.configuration.ingress.fqdn}'
output managedIdentityClientId string = managedIdentity.properties.clientId
