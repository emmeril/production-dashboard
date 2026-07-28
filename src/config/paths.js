const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

function createAppPaths(environment = process.env) {
  const databaseBackupDir = path.resolve(
    environment.DATABASE_BACKUP_DIR || path.join(projectRoot, 'database-backups')
  );

  return {
    projectRoot,
    publicDir: path.join(projectRoot, 'public'),
    viewsDir: path.join(projectRoot, 'src', 'views'),
    databasePath: path.resolve(
      environment.DATABASE_PATH || path.join(projectRoot, 'production-dashboard.sqlite')
    ),
    databaseBackupDir,
    legacyHistoryDir: path.resolve(
      environment.LEGACY_HISTORY_DIR || path.join(projectRoot, 'history')
    ),
    bootstrapCredentialsPath: path.join(databaseBackupDir, 'bootstrap-credentials.json')
  };
}

module.exports = { createAppPaths, projectRoot };
