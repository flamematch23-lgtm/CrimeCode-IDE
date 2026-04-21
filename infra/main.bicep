targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment')
param environmentName string

@minLength(1)
@description('Azure region for all resources')
param location string

var resourceSuffix = take(uniqueString(subscription().id, environmentName, location), 6)
var tags = { 'azd-env-name': environmentName }
var dbAdminPassword = uniqueString(subscription().id, environmentName, location, 'mysql-admin')

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module monitoring './modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
  }
}

module keyvault './modules/keyvault.bicep' = {
  name: 'keyvault'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
  }
}

module registry './modules/container-registry.bicep' = {
  name: 'registry'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
  }
}

module storage './modules/storage.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
  }
}

module database './modules/database.bicep' = {
  name: 'database'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
    adminPassword: dbAdminPassword
  }
}

module dbPasswordSecret './modules/keyvault-secret.bicep' = {
  name: 'dbPasswordSecret'
  scope: rg
  params: {
    keyVaultName: keyvault.outputs.name
    secretName: 'mysql-admin-password'
    secretValue: dbAdminPassword
  }
  dependsOn: [keyvault]
}

module aifoundry './modules/ai-foundry.bicep' = {
  name: 'aifoundry'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
  }
}

module containerApps './modules/container-apps.bicep' = {
  name: 'containerApps'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
    logAnalyticsCustomerId: monitoring.outputs.logAnalyticsCustomerId
    logAnalyticsPrimarySharedKey: monitoring.outputs.logAnalyticsPrimarySharedKey
    containerRegistryLoginServer: registry.outputs.loginServer
    containerRegistryName: registry.outputs.name
    keyVaultName: keyvault.outputs.name
    openAIEndpoint: aifoundry.outputs.endpoint
    mysqlHost: database.outputs.host
    storageAccountName: storage.outputs.accountName
    redisCacheHostName: storage.outputs.redisCacheHostName
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
  }
}

module staticWebApps './modules/static-web-apps.bicep' = {
  name: 'staticWebApps'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.outputs.loginServer
output AZURE_KEY_VAULT_NAME string = keyvault.outputs.name
output AZURE_LOG_ANALYTICS_WORKSPACE_ID string = monitoring.outputs.workspaceId
output AZURE_OPENAI_ENDPOINT string = aifoundry.outputs.endpoint
output OPENCODE_SERVER_URL string = containerApps.outputs.opencodeServerUrl
output API_URL string = containerApps.outputs.apiUrl
output CONSOLE_URL string = staticWebApps.outputs.consoleUrl
output DOCS_URL string = staticWebApps.outputs.docsUrl
output APP_URL string = staticWebApps.outputs.appUrl
