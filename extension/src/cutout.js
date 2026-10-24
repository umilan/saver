// Cuts a product picture out of its plain background: the near-white area that touches the
// picture's edges becomes transparent, so the product stands on the card's own colour.
// White inside the product (a white lamp's shade, a label) is kept, because only background
// reached from the edges is cleared. The edge of the cut is softened by one pixel.
//
// Needs the picture's pixels: this device's copy (thumbs.js) always works; a picture straight
// from a shop only when the shop allows it (CORS) or the extension may read that shop.
// Gives null when the pixels cannot be read or there is no plain background to remove.

const SIZE = 480;
// How close to white a pixel must be to count as background (0–255 per channel), and how far
// its channels may differ from each other (so pale colours are not taken for white).
const MIN_LIGHT = 232;
const MAX_TINT = 18;
// The light fringe a resized picture leaves around the product, made half see-through.
const FRINGE_LIGHT = 200;
// Less than this share of the picture cleared means it had no plain background.
const MIN_CLEARED = 0.04;

const made = new Map();

export function cutout(src) {
  if (!made.has(src)) made.set(src, make(src).catch(() => null));
  return made.get(src);
}

async function make(src) {
  const bitmap = await readPicture(src);
  const scale = Math.min(1, SIZE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const image = context.getImageData(0, 0, width, height);
  if (!clearBackground(image.data, width, height)) return null;
  context.putImageData(image, 0, 0);
  return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
}

// The picture's pixels: a copy or a shop that allows reading gives them directly; otherwise
// the extension fetches the picture itself (only for shops it may read).
async function readPicture(src) {
  try {
    const response = await fetch(src, { credentials: 'omit' });
    if (response.ok) return await createImageBitmap(await response.blob());
  } catch {}
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  return createImageBitmap(img);
}

const isLight = (data, at, min) => {
  const r = data[at];
  const g = data[at + 1];
  const b = data[at + 2];
  return data[at + 3] > 0 && Math.min(r, g, b) >= min && Math.max(r, g, b) - Math.min(r, g, b) <= MAX_TINT;
};
const isBackground = (data, at) => isLight(data, at, MIN_LIGHT);

// Flood fill from every edge pixel that looks like background. Returns false when too little
// of the picture was background to bother.
function clearBackground(data, width, height) {
  const cleared = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    const index = y * width + x;
    if (cleared[index] || !isBackground(data, index * 4)) return;
    cleared[index] = 1;
    stack.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  let count = 0;
  while (stack.length) {
    const index = stack.pop();
    count += 1;
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  if (count < width * height * MIN_CLEARED) return false;
  for (let index = 0; index < cleared.length; index += 1) {
    if (cleared[index]) {
      data[index * 4 + 3] = 0;
      continue;
    }
    // A kept pixel next to cleared background: half see-through, so the cut is not jagged.
    const x = index % width;
    const touches = (x > 0 && cleared[index - 1]) || (x < width - 1 && cleared[index + 1]) || cleared[index - width] || cleared[index + width];
    if (touches && isLight(data, index * 4, FRINGE_LIGHT)) data[index * 4 + 3] = 128;
  }
  return true;
}
