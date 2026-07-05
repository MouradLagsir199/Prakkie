using 'main.bicep'

param env = 'dev'
param location = 'westeurope'
param ownerEmail = 'daniel.vanmeurs@creates.nl'
// 'pg-prakkie-dev' is stuck behind a stale ARM name reservation from the aborted westeurope create
param pgServerName = 'pg-prakkie-{env}-ne'
// pgAdminPassword and adminIpAddress are supplied by scripts/deploy.ps1 at run time — never stored here
param pgAdminPassword = ''
