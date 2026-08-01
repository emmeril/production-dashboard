const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

function absolutePath(relativePath) {
  return path.join(projectRoot, relativePath);
}

function read(relativePath) {
  return fs.readFileSync(absolutePath(relativePath));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha384(buffer) {
  return crypto.createHash('sha384').update(buffer).digest('hex');
}

const indexHtml = read('src/views/index.html').toString('utf8');
const publicDisplayHtml = read('src/views/public-display.html').toString('utf8');
const renderedViews = indexHtml + publicDisplayHtml;
const forbiddenRuntimeCdns = [
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net/npm/alpinejs',
  'cdn.jsdelivr.net/npm/chart.js',
  'cdnjs.cloudflare.com/ajax/libs/font-awesome',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

forbiddenRuntimeCdns.forEach(host => {
  assert(!renderedViews.includes(host), `Aset runtime layout tidak boleh memakai CDN: ${host}`);
});

const requiredAssets = [
  'public/assets/css/tailwind.css',
  'public/assets/css/fonts.css',
  'public/assets/css/fontawesome.min.css',
  'public/assets/js/vendor/alpine.min.js',
  'public/assets/js/vendor/chart.umd.min.js'
];

requiredAssets.forEach(relativePath => {
  assert(fs.existsSync(absolutePath(relativePath)), `Aset lokal tidak ditemukan: ${relativePath}`);
  assert(read(relativePath).length > 1000, `Aset lokal tidak lengkap: ${relativePath}`);
});

const vendorCopies = [
  ['node_modules/alpinejs/dist/cdn.min.js', 'public/assets/js/vendor/alpine.min.js'],
  ['node_modules/chart.js/dist/chart.umd.min.js', 'public/assets/js/vendor/chart.umd.min.js'],
  ['node_modules/@fortawesome/fontawesome-free/css/all.min.css', 'public/assets/css/fontawesome.min.css'],
  ['node_modules/@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2', 'public/assets/fonts/dm-sans-latin-400-normal.woff2'],
  ['node_modules/@fontsource/dm-sans/files/dm-sans-latin-500-normal.woff2', 'public/assets/fonts/dm-sans-latin-500-normal.woff2'],
  ['node_modules/@fontsource/dm-sans/files/dm-sans-latin-600-normal.woff2', 'public/assets/fonts/dm-sans-latin-600-normal.woff2'],
  ['node_modules/@fontsource/dm-sans/files/dm-sans-latin-700-normal.woff2', 'public/assets/fonts/dm-sans-latin-700-normal.woff2'],
  ['node_modules/@fontsource/manrope/files/manrope-latin-600-normal.woff2', 'public/assets/fonts/manrope-latin-600-normal.woff2'],
  ['node_modules/@fontsource/manrope/files/manrope-latin-700-normal.woff2', 'public/assets/fonts/manrope-latin-700-normal.woff2'],
  ['node_modules/@fontsource/manrope/files/manrope-latin-800-normal.woff2', 'public/assets/fonts/manrope-latin-800-normal.woff2']
];

vendorCopies.forEach(([source, target]) => {
  if (!fs.existsSync(absolutePath(source))) return;
  assert(sha384(read(source)) === sha384(read(target)), `Aset vendor perlu disinkronkan: ${target}`);
});

const tailwindCss = read('public/assets/css/tailwind.css').toString('utf8');
['.flex{', '.bg-blue-600{', '.text-gray-800{', '@media (min-width:768px)'].forEach(selector => {
  assert(tailwindCss.includes(selector), `Build Tailwind kehilangan selector penting: ${selector}`);
});

const fontAwesomeCssPath = absolutePath('public/assets/css/fontawesome.min.css');
const fontAwesomeCss = fs.readFileSync(fontAwesomeCssPath, 'utf8');
const fontFiles = Array.from(fontAwesomeCss.matchAll(/url\((?:\.\.\/webfonts\/)?([^)]+?\.(?:woff2|ttf))\)/g), match => match[1]);
assert(fontFiles.length > 0, 'Font Awesome tidak mereferensikan file font lokal');
fontFiles.forEach(filename => {
  const relativePath = `public/assets/webfonts/${filename}`;
  assert(fs.existsSync(absolutePath(relativePath)), `Webfont tidak ditemukan: ${relativePath}`);
});

console.log(`Asset check passed: ${requiredAssets.length} runtime assets and ${fontFiles.length} webfonts`);
