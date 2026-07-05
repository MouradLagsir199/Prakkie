using 'main.bicep'

param env = 'prod'
param location = 'westeurope'
param ownerEmail = 'daniel.vanmeurs@creates.nl'
// pgAdminPassword and adminIpAddress are supplied by scripts/deploy.ps1 at run time — never stored here
param pgAdminPassword = ''
