// Bundles the real dist pages + a mock Tauri backend into single self-contained
// HTML files, so they can run in a plain browser for testing.
// Run: node scripts/test/build.cjs
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'), dist = path.join(root, 'dist');
const read = p => fs.readFileSync(path.join(dist, p), 'utf8');
const mock = fs.readFileSync(path.join(__dirname, 'mock-tauri.js'), 'utf8');
const fonts = '<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">';
const js = s => '<script>\n' + s.replace(/<\/script>/g, '<\\/script>') + '\n</script>';

function page(title, cssFiles, bodyHtml, jsFiles, extraCss){
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>' + title + '</title>' + fonts +
    '<style>' + cssFiles.map(read).join('\n') + (extraCss || '') + '</style></head><body>' + bodyHtml +
    js(mock) + jsFiles.map(f => js(read(f))).join('') + '</body></html>';
}

const ovHtml = read('overlay/index.html');
const overlayBody = ovHtml.slice(ovHtml.indexOf('<body>') + 6, ovHtml.indexOf('<script'));
fs.writeFileSync(path.join(__dirname, 'overlay.built.html'),
  page('overlay test', ['shared/hud.css', 'overlay/overlay.css'], overlayBody, ['shared/hud.js', 'overlay/overlay.js'],
    'html,body{background:#2a2440 !important;}'));

const mainHtml = read('main/index.html');
const mainBody = mainHtml.slice(mainHtml.indexOf('<div class="page">'), mainHtml.indexOf('<script'));
fs.writeFileSync(path.join(__dirname, 'main.built.html'),
  page('settings test', ['shared/hud.css', 'main/main.css'], mainBody, ['shared/hud.js', 'main/main.js']));

console.log('built overlay.built.html and main.built.html');
