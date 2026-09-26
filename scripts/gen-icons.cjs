// One-off placeholder icon generator (no deps). Produces solid-color square
// PNGs at the sizes Tauri expects, plus a minimal .ico wrapping a PNG frame.
// Run: node scripts/gen-icons.cjs
// Replace these with real artwork later — `npm run tauri icon <source.png>`
// (via @tauri-apps/cli) regenerates the whole set from one 1024x1024 source.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'src-tauri', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// amber-on-dark, matches --accent / --bg from the overlay design tokens
const BG = [0x0b, 0x0c, 0x10, 0xff];
const FG = [0xff, 0xb4, 0x54, 0xff];

function crc32(buf) {
  let c, table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let cc = n;
      for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xedb88320 ^ (cc >>> 1) : cc >>> 1;
      t[n] = cc;
    }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  // simple centered rounded-ish square glyph: fill bg, draw a smaller
  // inset square of the accent color so the icon reads at small sizes.
  const inset = Math.max(1, Math.round(size * 0.28));
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter type none
    for (let x = 0; x < size; x++) {
      const inGlyph = x >= inset && x < size - inset && y >= inset && y < size - inset;
      const col = inGlyph ? FG : BG;
      const px = rowStart + 1 + x * 4;
      raw[px] = col[0]; raw[px + 1] = col[1]; raw[px + 2] = col[2]; raw[px + 3] = col[3];
    }
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

const sizes = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512 };
for (const [name, size] of Object.entries(sizes)) {
  fs.writeFileSync(path.join(OUT, name), makePng(size));
  console.log('wrote', name);
}

// Minimal .ico: ICONDIR + one ICONDIRENTRY pointing at a 256x256 PNG payload
// (Windows Vista+ accepts PNG-compressed frames inside .ico directly).
function makeIco(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // 1 image

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // size of image data
  entry.writeUInt32LE(header.length + entry.length, 12); // offset

  return Buffer.concat([header, entry, pngBuf]);
}
const icoPng = makePng(256);
fs.writeFileSync(path.join(OUT, 'icon.ico'), makeIco(icoPng, 256));
console.log('wrote icon.ico');

// Tray icon (small, same glyph)
fs.writeFileSync(path.join(OUT, 'tray.png'), makePng(32));
console.log('wrote tray.png');
