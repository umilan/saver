// Cuts a product picture out of its plain background, so the product stands on the card's own
// colour. Shop pictures of white furniture are the hard case: the product is nearly as white
// as the background and its outline has gaps, so a plain flood fill from the edges runs into
// the product. This one:
//
// 1. takes the background colour from the picture's border (most shops use pure white, some
//    a light grey) and gives up when the border is not one plain colour (a photo);
// 2. marks the pixels within a small distance of that colour (JPEG noise included) as
//    background-coloured;
// 3. floods from the edges only through pixels whose whole neighbourhood (GAP pixels each
//    way) is background-coloured, so it cannot slip through a gap narrower than that in
//    an outline, then grows the cleared area back by GAP into background-coloured pixels so
//    the cut still reaches the product's edge;
// 4. clears small specks the cut left standing (smaller than SPECK of the picture), and
//    softens the cut's edge by one pixel.
//
// White inside the product is kept: only background reached from the edges is cleared.
// Needs the picture's pixels: this device's copy (thumbs.js) always works; a picture straight
// from a shop only when the shop allows it (CORS) or the extension may read that shop.
// Gives null when the pixels cannot be read or there is no plain background to remove.

const SIZE = 480;
// How far (per channel, 0–255) a pixel may be from the background colour to count as it.
const CLOSE = 10;
// The border counts as one plain colour when this share of its pixels is close to the median.
const PLAIN_BORDER = 0.9;
// The widest gap in a product's outline the flood cannot pass, in pixels each way.
const GAP = 2;
// Pieces left standing smaller than this share of the picture are cleared too.
const SPECK = 0.0015;
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

function borderIndexes(width, height) {
  const indexes = [];
  for (let x = 0; x < width; x += 1) indexes.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y += 1) indexes.push(y * width, y * width + width - 1);
  return indexes;
}

// The border's colour, channel by channel the median; null when the border is not plain.
function backgroundColour(data, width, height) {
  const border = borderIndexes(width, height);
  const median = [0, 1, 2].map((channel) => {
    const values = border.map((index) => data[index * 4 + channel]).sort((a, b) => a - b);
    return values[values.length >> 1];
  });
  const near = border.filter((index) => [0, 1, 2].every((channel) => Math.abs(data[index * 4 + channel] - median[channel]) <= CLOSE)).length;
  return near >= border.length * PLAIN_BORDER ? median : null;
}

function clearBackground(data, width, height) {
  const colour = backgroundColour(data, width, height);
  if (!colour) return false;
  const total = width * height;
  const distance = (index) => Math.max(...[0, 1, 2].map((channel) => Math.abs(data[index * 4 + channel] - colour[channel])));

  // 2. Background-coloured pixels, and a running count of the others for the window test.
  const like = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) like[index] = data[index * 4 + 3] > 0 && distance(index) <= CLOSE ? 1 : 0;
  const counts = new Int32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += 1 - like[y * width + x];
      counts[(y + 1) * (width + 1) + x + 1] = counts[y * (width + 1) + x + 1] + row;
    }
  }
  // No other pixel within GAP of (x, y), the picture's edge counting as background.
  const open = (x, y) => {
    const left = Math.max(0, x - GAP);
    const top = Math.max(0, y - GAP);
    const right = Math.min(width, x + GAP + 1);
    const bottom = Math.min(height, y + GAP + 1);
    const W = width + 1;
    return counts[bottom * W + right] - counts[top * W + right] - counts[bottom * W + left] + counts[top * W + left] === 0;
  };

  // 3. Flood through open pixels from the edges, then grow back by GAP.
  const cleared = new Uint8Array(total);
  const stack = [];
  const visit = (index) => {
    if (cleared[index] || !like[index]) return;
    const x = index % width;
    if (!open(x, (index - x) / width)) return;
    cleared[index] = 1;
    stack.push(index);
  };
  for (const index of borderIndexes(width, height)) visit(index);
  const neighbours = (index, each) => {
    const x = index % width;
    if (x > 0) each(index - 1);
    if (x < width - 1) each(index + 1);
    if (index >= width) each(index - width);
    if (index < total - width) each(index + width);
  };
  while (stack.length) neighbours(stack.pop(), visit);
  let edge = [];
  for (let index = 0; index < total; index += 1) if (cleared[index]) edge.push(index);
  for (let step = 0; step < GAP + 1; step += 1) {
    const next = [];
    for (const index of edge) {
      neighbours(index, (other) => {
        if (cleared[other] || !like[other]) return;
        cleared[other] = 1;
        next.push(other);
      });
    }
    edge = next;
  }

  // 4. Small pieces left standing go too: specks of noise and slivers of background.
  const piece = new Int32Array(total).fill(-1);
  for (let start = 0; start < total; start += 1) {
    if (cleared[start] || piece[start] !== -1) continue;
    const members = [start];
    piece[start] = start;
    for (let i = 0; i < members.length; i += 1) {
      neighbours(members[i], (other) => {
        if (cleared[other] || piece[other] !== -1) return;
        piece[other] = start;
        members.push(other);
      });
    }
    if (members.length < total * SPECK) for (const index of members) cleared[index] = 1;
  }

  let count = 0;
  for (let index = 0; index < total; index += 1) count += cleared[index];
  if (count < total * MIN_CLEARED) return false;
  for (let index = 0; index < total; index += 1) {
    if (cleared[index]) {
      data[index * 4 + 3] = 0;
      continue;
    }
    // A kept pixel on the cut, close to the background colour: half see-through, so the
    // edge is not jagged.
    let touches = false;
    neighbours(index, (other) => (touches ||= cleared[other] === 1));
    if (touches && distance(index) <= CLOSE * 4) data[index * 4 + 3] = 128;
  }
  return true;
}
