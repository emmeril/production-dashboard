function normalizeLogMessage(message) {
  return String(message || '')
    .replace(/[^\x20-\x7E]+/g, '')
    .replace(/^\s*(ERROR|WARNING)\s*:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function logMessage(level, message) {
  return `[${new Date().toISOString()}] [${level}] ${normalizeLogMessage(message)}`;
}

const logger = {
  info(message, ...details) {
    console.log(logMessage('INFO', message), ...details);
  },
  warn(message, ...details) {
    console.warn(logMessage('WARN', message), ...details);
  },
  error(message, error) {
    if (typeof error === 'undefined') {
      console.error(logMessage('ERROR', message));
      return;
    }

    console.error(logMessage('ERROR', message), error instanceof Error ? (error.stack || error.message) : error);
  }
};

module.exports = { logger, logMessage, normalizeLogMessage };
