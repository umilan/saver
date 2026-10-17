// Items that arrived as a bare link (shared from the iPhone shortcut, or added with + in the
// web app) get their name, picture and price from the shop page, once the extension may
// read that shop. `read(url, spots)` reads the page (readpage.js, or the background
// worker's offscreen page).

import { getState, isBare, priceSpotFor, titleSpotFor, updateProduct } from './store.js';

const LOCK = 'shopmarks-fill';
// Tried once per run of the page or worker; a page that could not be read is not retried
// on every sync.
const tried = new Set();

export function fillDetails(read) {
  return navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock || !globalThis.chrome?.permissions?.contains) return;
    for (const product of (await getState()).products.filter(isBare)) {
      if (tried.has(product.id)) continue;
      tried.add(product.id);
      const origins = [`${new URL(product.url).origin}/*`];
      if (!(await chrome.permissions.contains({ origins }).catch(() => false))) continue;
      const [priceSpot, titleSpot] = await Promise.all([priceSpotFor(product.url), titleSpotFor(product.url)]);
      const page = await read(product.url, { priceSpot, titleSpot });
      if (!page) continue;
      const patch = {};
      if (page.title) patch.title = page.title;
      if (page.images?.[0]) patch.image = page.images[0];
      if (page.price != null) Object.assign(patch, { price: page.price, currency: page.currency ?? null });
      if (Object.keys(patch).length) await updateProduct(product.id, patch);
    }
  });
}
