const application = require('./src/app');

if (require.main === module) {
  application.startServer().catch(error => {
    console.error('Server gagal dijalankan:', error);
    process.exitCode = 1;
  });
}

module.exports = application;
