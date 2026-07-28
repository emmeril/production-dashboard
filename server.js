const application = require('./src/app');

if (require.main === module) {
  application.startServer();
}

module.exports = application;
