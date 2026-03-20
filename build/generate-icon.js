// Generate icon PNGs from SVG using Node.js canvas-free approach
// Creates a simple 1024x1024 icon as a PPM then converts via sips

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const size = 1024;
const pixels = Buffer.alloc(size * size * 3);

function setPixel(x, y, r, g, b) {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 3;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
}

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// Fill with gradient background (purple)
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const t = (x + y) / (2 * size);
    const r = lerp(124, 79, t);  // #7C5CFC -> #4F46E5
    const g = lerp(92, 70, t);
    const b = lerp(252, 229, t);

    // Rounded rectangle mask (radius 220)
    const rad = 220;
    let inside = true;
    if (x < rad && y < rad) inside = dist(x, y, rad, rad) <= rad;
    else if (x > size - rad && y < rad) inside = dist(x, y, size - rad, rad) <= rad;
    else if (x < rad && y > size - rad) inside = dist(x, y, rad, size - rad) <= rad;
    else if (x > size - rad && y > size - rad) inside = dist(x, y, size - rad, size - rad) <= rad;

    if (inside) {
      setPixel(x, y, r, g, b);
    } else {
      setPixel(x, y, 0, 0, 0); // transparent (will be masked)
    }
  }
}

// Draw circle (globe outline)
const cx = 512, cy = 512, radius = 280, thickness = 21;
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const d = dist(x, y, cx, cy);
    // Globe circle
    if (Math.abs(d - radius) < thickness) {
      setPixel(x, y, 240, 240, 255);
    }
    // Horizontal ellipse
    const ex = (x - cx) / radius;
    const ey = (y - cy) / 100;
    const ed = Math.sqrt(ex * ex + ey * ey);
    if (Math.abs(ed - 1) < 0.08 && d < radius + 5) {
      setPixel(x, y, 230, 230, 255);
    }
    // Vertical ellipse
    const vx = (x - cx) / 100;
    const vy = (y - cy) / radius;
    const vd = Math.sqrt(vx * vx + vy * vy);
    if (Math.abs(vd - 1) < 0.08 && d < radius + 5) {
      setPixel(x, y, 230, 230, 255);
    }
    // Horizontal line
    if (Math.abs(y - cy) < 14 && d < radius) {
      setPixel(x, y, 235, 235, 255);
    }
    // CDP dot (cyan)
    const dotDist = dist(x, y, 720, 340);
    if (dotDist < 64) {
      setPixel(x, y, 34, 211, 238); // #22D3EE
    }
    if (dotDist < 32) {
      setPixel(x, y, 255, 255, 255);
    }
  }
}

// Write PPM
const header = `P6\n${size} ${size}\n255\n`;
const ppmPath = path.join(__dirname, 'icon.ppm');
const pngPath = path.join(__dirname, 'icon.png');
fs.writeFileSync(ppmPath, Buffer.concat([Buffer.from(header), pixels]));

// Convert PPM to PNG via sips
execSync(`sips -s format png "${ppmPath}" --out "${pngPath}"`, { stdio: 'inherit' });
fs.unlinkSync(ppmPath);

// Generate iconset
const iconsetDir = path.join(__dirname, 'icon.iconset');
if (!fs.existsSync(iconsetDir)) fs.mkdirSync(iconsetDir);

const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const s of sizes) {
  execSync(`sips -z ${s} ${s} "${pngPath}" --out "${iconsetDir}/icon_${s}x${s}.png"`, { stdio: 'inherit' });
  if (s <= 512) {
    execSync(`sips -z ${s * 2} ${s * 2} "${pngPath}" --out "${iconsetDir}/icon_${s}x${s}@2x.png"`, { stdio: 'inherit' });
  }
}

// Build .icns
const icnsPath = path.join(__dirname, 'icon.icns');
execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`, { stdio: 'inherit' });

// Cleanup iconset
fs.rmSync(iconsetDir, { recursive: true });

console.log('Generated:', pngPath, icnsPath);
