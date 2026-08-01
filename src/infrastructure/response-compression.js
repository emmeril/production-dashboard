const zlib = require('zlib');

const COMPRESSIBLE_CONTENT_TYPE = /^(?:text\/|application\/(?:json|javascript|x-javascript|xml|svg\+xml))/i;

function acceptsGzip(header = '') {
  return String(header)
    .split(',')
    .some(value => {
      const [encoding, ...parameters] = value.trim().toLowerCase().split(';');
      if (encoding !== 'gzip' && encoding !== '*') return false;
      const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
      return !quality || Number(quality.split('=')[1]) > 0;
    });
}

function createResponseCompressionMiddleware({ threshold = 1024 } = {}) {
  return function responseCompressionMiddleware(req, res, next) {
    if (req.method === 'HEAD' || !acceptsGzip(req.headers['accept-encoding'])) return next();

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let started = false;
    let passthrough = false;
    const chunks = [];

    function startStream() {
      if (started) return;
      started = true;

      const contentType = String(res.getHeader('Content-Type') || '');
      const contentLength = Number(res.getHeader('Content-Length'));
      if (res.headersSent
        || res.statusCode === 204
        || res.statusCode === 304
        || res.getHeader('Content-Encoding')
        || !COMPRESSIBLE_CONTENT_TYPE.test(contentType)
        || (Number.isFinite(contentLength) && contentLength < threshold)) {
        passthrough = true;
        return;
      }

      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
    }

    res.write = (chunk, encoding, callback) => {
      startStream();
      if (passthrough) return originalWrite(chunk, encoding, callback);
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (callback) process.nextTick(callback);
      return true;
    };

    res.end = (chunk, encoding, callback) => {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
        encoding = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }

      startStream();
      if (passthrough) return originalEnd(chunk, encoding, callback);
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      const compressed = zlib.gzipSync(Buffer.concat(chunks), { level: zlib.constants.Z_BEST_SPEED });
      return originalEnd(compressed, callback);
    };

    next();
  };
}

module.exports = { createResponseCompressionMiddleware };
