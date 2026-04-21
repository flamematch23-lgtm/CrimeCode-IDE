targetScope = 'resourceGroup'

param location string = resourceGroup().location
param tags object = {}
param resourceSuffix string

@secure()
param adminPassword string

resource mysql 'Microsoft.DBforMySQL/flexibleServers@2023-06-30' = {
  name: 'mysql-${resourceSuffix}'
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: 'mysqladmin'
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: 20
      iops: 396
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    version: '8.0.21'
  }
}

resource database 'Microsoft.DBforMySQL/flexibleServers/databases@2023-06-30' = {
  parent: mysql
  name: 'crimecode'
  properties: {
    charset: 'utf8mb4'
    collation: 'utf8mb4_unicode_ci'
  }
}

output host string = mysql.properties.fullyQualifiedDomainName
output name string = mysql.name
output databaseName string = database.name
