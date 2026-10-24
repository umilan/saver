import { startBackup } from './backup.js';
import { fillDetails } from './fill.js';
import { startDropboxSync, syncNow } from './sync.js';
import { syncThumbs } from './thumbs.js';
import { extractFromTab } from './page.js';
import { findByUrl, forgetOldVisits, getState, rememberVisit, saveProduct, setPriceSpot, setTitleSpot, updateProduct, visitDays, visitsPaused } from './store.js';

const MENU_ID = 'saver-save-page';
const BADGE_OK = '#1f6f5c';
const BADGE_ERROR = '#b3261e';
const SYNC_ALARM = 'dropbox-sync';
const SYNC_EVERY_MINUTES = 5;

// Keeps the backup file and the Dropbox copy (with the picture copies) current when no
// ShopMarx page is open.
startBackup();
startDropboxSync(afterSync);

// Also every few minutes, so links shared from the iPhone arrive with no ShopMarx page open.
chrome.alarms.get(SYNC_ALARM).then((alarm) => alarm || chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_EVERY_MINUTES }));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  syncNow().then((synced) => synced && afterSync()).catch(() => {});
  visitDays().then(forgetOldVisits).catch(() => {});
});

// Remembering visited product pages (opt-in, see store.js rememberVisit): a moment after a
// page in a normal window finishes loading, or after a shop's own page change (shops that
// swap the product without a reload), the page is read as the popup reads it; a product page
// goes into Visited. Needs the access to all sites asked for when it was turned on; private
// windows are left alone.
const VISIT_DELAY = 2000;
const visitTimers = new Map();

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== 'complete') return;
  if (tab.incognito || !/^https?:/.test(tab.url ?? '')) return;
  clearTimeout(visitTimers.get(tabId));
  visitTimers.set(tabId, setTimeout(() => {
    visitTimers.delete(tabId);
    rememberTab(tabId, tab.url).catch(() => {});
  }, VISIT_DELAY));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(visitTimers.get(tabId));
  visitTimers.delete(tabId);
});

async function rememberTab(tabId, url) {
  if (!(await visitDays()) || (await visitsPaused())) return;
  if (!(await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] }))) return;
  const tab = await chrome.tabs.get(tabId);
  // Moved on to another page meanwhile: that one has its own timer.
  if (tab.url !== url || tab.status !== 'complete') return;
  const draft = await extractFromTab(tabId);
  if (draft?.isProduct && draft.title) await rememberVisit(draft);
}

// Shared links get their details first, so the picture copy is made of the right picture.
async function afterSync() {
  await fillDetails(readInOffscreen).catch(() => {});
  await syncThumbs().catch(() => {});
}

// The worker has no DOMParser: shop pages are read in a hidden offscreen page.
async function readInOffscreen(url, spots) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen
      .createDocument({ url: 'src/offscreen.html', reasons: ['DOM_PARSER'], justification: 'Read product details from shop pages' })
      .catch(() => {}); // Another call created it in between.
  }
  return chrome.runtime.sendMessage({ type: 'read-page', url, spots });
}

chrome.runtime.onInstalled.addListener(() => {
  // Menus survive updates, so start clean instead of failing on a duplicate id.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Save this product to ShopMarx', contexts: ['page', 'image'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  try {
    const draft = await extractFromTab(tab.id);
    const { products } = await getState();
    const saved = findByUrl(products, draft.url);
    if (saved) {
      // Already saved: record the current price, keep what the user edited.
      if (draft.price != null) await updateProduct(saved.id, { price: draft.price, currency: draft.currency ?? saved.currency });
    } else {
      // Right-clicking a picture is a clear statement of which image to keep.
      const image = info.mediaType === 'image' && info.srcUrl ? info.srcUrl : draft.images[0] ?? null;
      await saveProduct({ ...draft, image });
    }
    flashBadge(tab.id, '✓', BADGE_OK);
  } catch {
    flashBadge(tab.id, '!', BADGE_ERROR);
  }
});

// The popup's picker found the price or the product name on a shop page: remember the spot
// for that shop and reopen the popup, which then reads it from there (openPopup needs Chrome 127).
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab) return;
  const save = { 'price-spot': setPriceSpot, 'title-spot': setTitleSpot }[message?.type];
  if (!save) return;
  save(message.url, message.spot)
    .then(() => chrome.action.openPopup?.())
    .catch(() => {});
});

function flashBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 2500);
}
