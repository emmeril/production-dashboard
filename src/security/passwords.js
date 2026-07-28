const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function hashPassword(password) {
  return bcrypt.hashSync(String(password), 12);
}

function verifyPassword(password, hashedPassword) {
  if (typeof hashedPassword !== 'string') return false;
  if (hashedPassword.startsWith('$2')) {
    return bcrypt.compareSync(String(password), hashedPassword);
  }

  if (/^[a-f0-9]{64}$/i.test(hashedPassword)) {
    return crypto.createHash('sha256').update(String(password)).digest('hex') === hashedPassword;
  }

  return false;
}

function verifyPasswordAsync(password, hashedPassword) {
  if (typeof hashedPassword !== 'string' || !hashedPassword.startsWith('$2')) {
    return Promise.resolve(verifyPassword(password, hashedPassword));
  }

  return new Promise((resolve, reject) => {
    bcrypt.compare(String(password), hashedPassword, (error, matches) => {
      if (error) return reject(error);
      return resolve(matches);
    });
  });
}

function hashPasswordAsync(password) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(String(password), 12, (error, hash) => {
      if (error) return reject(error);
      return resolve(hash);
    });
  });
}

module.exports = {
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync
};
