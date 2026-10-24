import './tooltip.js';
import './version.js';
import { chosenLists, fillListChoice } from './listchoice.js';
import {
  connectDropbox,
  disconnectDropbox,
  dropboxAppKey,
  dropboxStatus,
  finishDropboxRedirect,
  redirectUri as dropboxRedirectUri,
  resetDropbox,
  saveDropboxAppKey,
  shortcutSetup,
  startDropboxSync,
  syncNow,
} from './sync.js';
import { fillDetails } from './fill.js';
import { cutout } from './cutout.js';
import { parseQuery } from './search.js';
import { readPage as readShopPage } from './readpage.js';
import { loadThumbs, onThumbsChange, retryFailedThumbs, syncThumbs, thumbFor } from './thumbs.js';
import { BACKUP_FILE, backupStatus, chooseFolder, forgetFolder, startBackup, writeBackup } from './backup.js';
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  NO_LIST_NAME,
  createList,
  listNamed,
  listLabel,
  deleteList,
  exportData,
  findByUrl,
  formatPrice,
  getState,
  importData,
  listsOf,
  loadRates,
  onChange,
  priceChange,
  priceSpots,
  normalizeUrl,
  titleSpotFor,
  removeProduct,
  restoreRecords,
  syncData,
  isBare,
  saveProduct,
  renameList,
  reorderLists,
  listTree,
  branchOf,
  hasOldShopLists,
  migrateShopLists,
  VISITED_LIST_ID,
  visitDays,
  setVisitDays,
  setCurrency,
  toEuro,
  updateProduct,
} from './store.js';

const $ = (id) => document.getElementById(id);
const PRICE_CHECKS_AT_ONCE = 4;
const TOAST_MS = 5000;
// A toast with Undo stays longer, so there is time to reach it.
const UNDO_MS = 8000;
const SYNC_EVERY_MS = 90 * 1000;

const euros = (product) => toEuro(product.price, product.currency, rates);
const comparePrice = (a, b) => (euros(a) ?? Infinity) - (euros(b) ?? Infinity) || 0;
const SORTS = {
  newest: (a, b) => b.createdAt - a.createdAt,
  'price-asc': comparePrice,
  'price-desc': (a, b) => (euros(b) ?? -Infinity) - (euros(a) ?? -Infinity) || 0,
  drop: (a, b) => (priceChange(a)?.percent ?? 0) - (priceChange(b)?.percent ?? 0),
  store: (a, b) => a.store.localeCompare(b.store),
  'store-desc': (a, b) => b.store.localeCompare(a.store),
  title: (a, b) => a.title.localeCompare(b.title),
  'title-desc': (a, b) => b.title.localeCompare(a.title),
};

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  edit: svg('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'),
  delete: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>'),
  more: svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),
  chevron: svg('<path d="m9 18 6-6-6-6"/>'),
  move: svg('<path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 9l3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>'),
  subList: svg('<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  note: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  sortAz: svg('<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M20 8h-5"/><path d="M15 10V6.5a2.5 2.5 0 0 1 5 0V10"/><path d="M15 14h5l-5 6h5"/>'),
  grip: svg('<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>'),
};
// How the cards show product pictures, picked in the settings and remembered on this device:
// 'blend' melts a white background into a grey tile (CSS only, the default), 'white' sits the
// picture on a white tile (CSS only), 'original' shows it as the shop does with its blurred
// copy behind, and 'cutout' removes the background (cutout.js; a picture it cannot cut
// shows as with 'blend').
const PICTURE_MODES = ['blend', 'white', 'original', 'cutout'];
let pictures = (() => {
  try {
    const saved = localStorage.getItem('pictures');
    return PICTURE_MODES.includes(saved) ? saved : 'blend';
  } catch {
    return 'blend';
  }
})();

function setPictures(mode) {
  pictures = mode;
  try {
    localStorage.setItem('pictures', mode);
  } catch {}
  render();
}

// Cards ticked with their checkbox; dragging one of them moves them all.
const selected = new Set();
// Until this time, redraws slide the cards to their new places (after a drop on a list).
let animateGridUntil = 0;

// listId null means "all items"; UNSORTED shows the items in no list.
const UNSORTED = 'unsorted';
const DRAG_TYPE = 'application/x-shopmarks-item';
// A list dragged in the sidebar to reorder it (cards use DRAG_TYPE).
const LIST_DRAG_TYPE = 'application/x-shopmarks-list';
// Running as the web app (PWA, see web.js) rather than inside the extension.
const WEB = Boolean(globalThis.shopMarksWeb);
// A drop target shown only while a card is dragged: deletes for good, after asking.
const TRASH = 'trash';
// The sidebar's Shops: every shop the items come from (their store). Its rows are views like
// lists: SHOPS shows every item, SHOP + shop the items from one shop and those in the shop's
// own lists. A shop's lists are ordinary lists with a `shop` (store.js, createList), shown
// under the shop instead of among the other lists.
const SHOPS = 'shops';
const SHOP = 'shop:';
// The views, in the order of their shortcuts: Cmd+1, Cmd+2, Cmd+3 (Ctrl on Windows).
// Defined before `view`, which reads the saved one.
const LAYOUTS = ['list', 'grid', 'compact'];
const DEFAULT_LAYOUT = 'compact';
// layout: 'list' of rows, 'grid' of cards or 'compact' (smaller cards, the default);
// remembered per browser.
const view = { listId: null, query: '', sort: 'newest', layout: savedLayout() };

// Lists folded shut in the sidebar (their sub-lists hidden); remembered on this device only.
const collapsedLists = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem('collapsedLists')) ?? [];
    } catch {
      return [];
    }
  })(),
);

function setCollapsed(id, collapsed) {
  if (collapsed) collapsedLists.add(id);
  else collapsedLists.delete(id);
  try {
    localStorage.setItem('collapsedLists', JSON.stringify([...collapsedLists]));
  } catch {}
}

// Long lists show the first BATCH items; the next batch is added when the end of the
// grid comes near the screen. A new list, search or sort starts again from the first batch.
const BATCH = 50;
const NEAR_END = 400;
let shownCount = BATCH;
let shownKey = '';

function nearEnd() {
  return $('grid-more').getBoundingClientRect().top < innerHeight + NEAR_END;
}

function showMore() {
  const products = visibleProducts();
  if (shownCount >= products.length) return;
  const start = shownCount;
  shownCount += BATCH;
  $('grid').append(...products.slice(start, shownCount).map(card));
  // Keep going while the end is still on screen, so a short batch does not stall.
  if (nearEnd()) showMore();
}

new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) showMore();
}, { rootMargin: `0px 0px ${NEAR_END}px` }).observe($('grid-more'));


function savedLayout() {
  try {
    return LAYOUTS.find((layout) => layout === localStorage.getItem('layout')) ?? DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}
let state = { products: [], lists: [], currency: DEFAULT_CURRENCY };
// The lists shown in the sidebar's own part: all but the shops' lists.
const mainLists = () => state.lists.filter((list) => !list.shop && list.id !== VISITED_LIST_ID);
// The Visited list (pages remembered on their own, see store.js), shown under Unsorted.
const visitedList = () => state.lists.find((list) => list.id === VISITED_LIST_ID);
// Items only in Visited are kept apart: they show in Visited alone, not in All Items, Shops
// or searches elsewhere (searching [visited] reaches them). Put in a list, they are yours.
const onlyVisited = (product) => listsOf(product).length === 1 && listsOf(product)[0] === VISITED_LIST_ID;
const ownProducts = () => state.products.filter((product) => !onlyVisited(product));
let rates = {};
let toastTimer;
let backup = { state: 'off' };

$('search').addEventListener('input', (event) => setView({ query: event.target.value }));
$('sort').addEventListener('change', (event) => setView({ sort: event.target.value }));
$('new-list').addEventListener('click', newList);
$('rename-list').addEventListener('click', renameCurrentList);
$('delete-list').addEventListener('click', deleteCurrentList);
$('check-prices').addEventListener('click', checkPrices);
$('add-item').addEventListener('click', addByLink);
$('dropbox-main').addEventListener('click', dropboxMain);
$('help-open').addEventListener('click', () => $('help-dialog').showModal());
$('dropbox-manage').addEventListener('click', () => connectToDropbox(true));
$('dropbox-clear').addEventListener('click', clearDropboxSetup);
$('dropbox-sync').addEventListener('click', () => runSync(true));
$('dropbox-disconnect').addEventListener('click', disconnectFromDropbox);
$('dropbox-pictures').addEventListener('click', allowAllPictures);
$('dropbox-shortcut').addEventListener('click', showShortcutSetup);
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const field = $(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(field.value);
      toast('Copied.');
    } catch {
      field.select(); // Copying was not allowed: selected, for the system's Copy.
    }
  });
}
// Reading the linked page needs access to its shop, asked for while the Add click still
// counts as the user's (permissions.request needs that).
let addPermission = null;
$('add-dialog').querySelector('form').addEventListener('submit', (event) => {
  addPermission = null;
  if (WEB || event.submitter?.value !== 'ok') return;
  try {
    const origins = [`${new URL($('add-url').value.trim()).origin}/*`];
    // Already allowed (e.g. by Update prices) also counts.
    addPermission = chrome.permissions.request({ origins }).catch(() => chrome.permissions.contains({ origins }));
  } catch {
    // Not a link; addByLink says so.
  }
});
$('export').addEventListener('click', exportToFile);
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', importFromFile);
$('backup-main').addEventListener('click', backupMain);
$('backup-change').addEventListener('click', chooseBackupFolder);
$('backup-stop').addEventListener('click', stopBackup);
// Opening the settings menu brings the backup and sync rows up to date ("2 min ago").
$('menu-toggle').addEventListener('click', () => {
  if (!$('backup-menu').hidden) refreshBackup();
  refreshDropbox();
  $('settings-dialog').showModal();
  // The dialog itself, not its first button: a focused × shows its tooltip on phones.
  $('settings-dialog').focus();
});
$('theme-toggle').addEventListener('click', toggleTheme);
$('pictures').value = pictures;
$('pictures').addEventListener('change', (event) => setPictures(event.target.value));

// Remembering visited product pages (opt-in): 0 is off, otherwise how many days a visited
// item that is only in Visited is kept. Turning it on asks for access to all sites.
visitDays().then((days) => ($('visit-days').value = String(days)));
$('visit-days').addEventListener('change', async (event) => {
  const days = Number(event.target.value);
  if (days) {
    // Must stay the first await: the permission prompt needs the choice that got us here.
    // (The localhost preview has no permissions to ask for.)
    const granted = globalThis.chrome?.permissions ? await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }).catch(() => false) : true;
    if (!granted) {
      event.target.value = String(await visitDays());
      return toast('Remembering visited pages needs access to the sites you visit.');
    }
  }
  await setVisitDays(days);
  toast(days ? `Product pages you visit go into Visited, kept for ${days} days unless you move them to a list.` : 'Visited product pages are no longer remembered.');
});

async function forgetVisited() {
  const only = state.products.filter(onlyVisited);
  if (!only.length) return toast('Nothing to forget: every visited item is in one of your lists too.');
  if (!(await confirmAction(`Forget ${only.length} visited ${only.length === 1 ? 'item' : 'items'}?`, 'Items you also put in one of your lists stay.'))) return;
  await track(async () => {
    for (const product of only) await removeProduct(product.id);
  }, `Forgot ${only.length} visited ${only.length === 1 ? 'item' : 'items'}.`);
}

// A dropdown opened with the mouse stays focused after its list closes, and Chrome then draws
// the keyboard focus ring on it. It is marked while used by pointer (ui.css hides the ring);
// a key press on it, or focus leaving it, brings normal focus rings back.
document.addEventListener('pointerdown', (event) => {
  const select = event.target.closest?.('select');
  if (select) select.dataset.pointer = '';
}, true);
for (const type of ['keydown', 'focusout']) {
  document.addEventListener(type, (event) => {
    if (event.target instanceof HTMLSelectElement) delete event.target.dataset.pointer;
  }, true);
}

// The lists sidebar can be hidden (desktop); remembered on this device.
function setSidebarHidden(hidden) {
  document.querySelector('.layout').classList.toggle('layout--no-sidebar', hidden);
  const toggle = $('sidebar-toggle');
  toggle.setAttribute('aria-expanded', String(!hidden));
  toggle.title = toggle.ariaLabel = hidden ? 'Show lists' : 'Hide lists';
  try {
    localStorage.setItem('sidebarHidden', hidden ? '1' : '');
  } catch {}
  placeControls();
}
$('sidebar-toggle').addEventListener('click', () => setSidebarHidden($('sidebar-toggle').getAttribute('aria-expanded') === 'true'));
function setLayout(layout) {
  view.layout = layout;
  try {
    localStorage.setItem('layout', layout);
  } catch {}
  render();
}
$('view-select').addEventListener('change', (event) => setLayout(event.target.value));
$('view-sheet').addEventListener('click', (event) => {
  const option = event.target.closest('.view-option');
  if (option) setLayout(option.dataset.layout);
});
$('delete-selected').addEventListener('click', () => deleteItems([...selected]));
$('select-toggle').addEventListener('click', () => {
  const shown = visibleProducts();
  if (shown.every((p) => selected.has(p.id))) selected.clear();
  else for (const product of shown) selected.add(product.id);
  render();
});
$('currency').append(...CURRENCIES.map((code) => new Option(code, code)));
$('currency').addEventListener('change', (event) => setCurrency(event.target.value));
$('brand').addEventListener('click', () => WEB || togglePopupPreview());
$('brand').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  togglePopupPreview();
});

// Each .menu is a toggle plus a sheet (cards make theirs on every redraw, so one handler
// serves all). The toggle opens or closes its menu; choosing an item closes it, and so
// does a click anywhere outside; opening one menu closes the others.
// Menus can sit inside menus (the ⋯ beside a settings item): opening the inner one leaves
// the outer one open.
document.addEventListener('click', (event) => {
  const toggled = event.target.closest('.menu__toggle')?.closest('.menu');
  for (const menu of document.querySelectorAll('.menu')) {
    if (menu === toggled) setMenu(menu, menu.querySelector(':scope > .menu__sheet').hidden);
    else if (toggled && menu.contains(toggled)) continue;
    else if (!menu.contains(event.target) || event.target.closest('.menu__item:not(.menu__item--stay)')) setMenu(menu, false);
  }
});
// Without hover (touch screens) a tap opens a note; a tap anywhere else closes it.
document.addEventListener('click', (event) => {
  if (!matchMedia('(hover: none)').matches) return;
  const tapped = event.target.closest('.card__note');
  for (const note of document.querySelectorAll('.card__note--open')) {
    if (note !== tapped) note.classList.remove('card__note--open');
  }
  tapped?.classList.toggle('card__note--open');
});
document.addEventListener('keydown', (event) => {
  const open = document.querySelector('.menu:has(.menu__sheet:not([hidden]))');
  if (event.key !== 'Escape' || !open) return;
  // Only the menu closes, not a dialog it is in.
  event.preventDefault();
  setMenu(open, false);
  open.querySelector('.menu__toggle').focus();
});

// The sticky rows sit under the ones above them, whose heights change as they wrap.
const stickyRows = new ResizeObserver(() => {
  document.body.style.setProperty('--topbar-height', `${document.querySelector('.topbar').offsetHeight}px`);
  document.body.style.setProperty('--sidebar-height', `${document.querySelector('.sidebar').offsetHeight}px`);
  // Where the stuck rows end, so a card scrolled to with the keyboard is not hidden under them.
  const head = document.querySelector('.main-head');
  document.body.style.setProperty('--sticky-bottom', `${(parseFloat(getComputedStyle(head).top) || 0) + head.offsetHeight}px`);
});
stickyRows.observe(document.querySelector('.topbar'));
stickyRows.observe(document.querySelector('.sidebar'));
stickyRows.observe(document.querySelector('.main-head'));

// On small screens the list picker moves up into the top bar and the sort dropdown goes to
// the top of the settings menu (with the view, which has its own dropdown there); + (add by link) is in the top bar there, and on wider screens in the
// heading row after the grid / list switch.
const narrow = matchMedia('(max-width: 800px)');
const placeControls = () => {
  if (narrow.matches) {
    $('search-field').before($('list-picker'));
    $('sort-row').append($('sort'));
    $('search-toggle').after($('add-item'));
  } else if (document.querySelector('.layout--no-sidebar')) {
    // Lists hidden: the list dropdown stands in for the heading's title.
    $('list-title').after($('list-picker'));
    $('sort-field').append($('sort'));
  } else {
    $('lists').after($('list-picker'));
    $('sort-field').append($('sort'));
    // Sort first, then the grid / list switch, then + (add by link).
    $('view-field').before($('sort-field'));
    $('view-field').after($('add-item'));
  }
};
narrow.addEventListener('change', placeControls);
placeControls();
// The sidebar as it was left on this device (after placeControls exists: it places the list dropdown).
try {
  setSidebarHidden(localStorage.getItem('sidebarHidden') === '1');
} catch {}

// Cmd+K (Ctrl+K on Windows) jumps to search from anywhere; the field shows the keys.
const MOD_KEY = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform) ? '⌘' : 'Ctrl';
for (const key of document.querySelectorAll('.mod-key')) key.textContent = MOD_KEY;
// Cmd+1, 2, 3 switch the view (list, grid, compact grid), as the view menu shows.
document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  const layout = LAYOUTS[Number(event.key) - 1];
  if (!layout || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  setLayout(layout);
});

// Where the focus was before Cmd+K, for Escape to go back to.
let beforeSearch = null;
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (document.activeElement !== $('search')) beforeSearch = document.activeElement;
  if (narrow.matches) setSearch(true);
  $('search').focus();
  $('search').select();
});

// On small screens search is an icon that opens the field in place of the pickers.
$('search-toggle').addEventListener('click', () => setSearch($('search-toggle').getAttribute('aria-expanded') !== 'true'));
// Escape leaves search: on small screens it closes the field; on wider ones the text stays
// (the browser would clear it) and the focus goes back to where it was before Cmd+K.
$('search').addEventListener('keydown', (event) => {
  if (/^Arrow/.test(event.key) && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
    const box = $('search');
    // While searching, down goes straight to the results; left and right leave the box only
    // from the start or the end of its text.
    const results = event.key === 'ArrowDown' && view.query.trim() ? (matchChips()[0] ?? firstCard()) : null;
    if (event.key === 'ArrowUp') return;
    if (event.key === 'ArrowLeft' && (box.selectionStart > 0 || box.selectionEnd > 0)) return;
    if (event.key === 'ArrowRight' && box.selectionStart < box.value.length) return;
    const target = results ?? spatialTarget(box, event.key);
    if (!target) return;
    event.preventDefault();
    goTo(target);
    return;
  }
  if (event.key !== 'Escape') return;
  event.preventDefault();
  if (narrow.matches) {
    setSearch(false);
    $('search-toggle').focus();
    return;
  }
  // Searching redraws the sidebar, so a list is found again by its id.
  let back = beforeSearch;
  if (back && !back.isConnected && back.dataset?.nav !== undefined) back = navLink(back.dataset.nav);
  if (!back?.isConnected || back === document.body) back = null;
  beforeSearch = null;
  if (back) back.focus();
  else $('search').blur();
});

const NEW_LIST = 'new-list';
$('list-picker').addEventListener('change', (event) => {
  if (event.target.value !== NEW_LIST) return setView({ listId: event.target.value || null });
  // Not a real list: snap back to the current one and ask for a name.
  event.target.value = view.listId ?? '';
  newList();
});

onChange(refresh);
// Pictures show from this device's copies (thumbs.js) once they are loaded.
loadThumbs().finally(refresh);
onThumbsChange(() => loadThumbs().then(render));
loadRates().then((loaded) => {
  rates = loaded;
  render();
});

// The switch offers the opposite of what is showing, which follows the system until it is used.
const systemDark = matchMedia('(prefers-color-scheme: dark)');
systemDark.addEventListener('change', showThemeSwitch);
showThemeSwitch();

// The web app cannot read shop pages or open the toolbar popup.
if (WEB) {
  $('check-prices').hidden = true;
  // Only the extension sees the pages visited in Chrome.
  $('visit-row').hidden = true;
  $('brand').removeAttribute('role');
  $('brand').removeAttribute('tabindex');
  document.querySelector('.brand').style.cursor = 'auto';
}

// Dropbox: finish a sign-in the web app just came back from, then sync now, whenever the
// page is shown again, and (in the web app, which has no background worker) after changes.
finishDropboxRedirect()
  .then((connected) => connected && toast('Connected to Dropbox.'))
  .catch(() => toast('Dropbox sign-in did not finish. Try again from the settings menu.'))
  .finally(() => runSync(false));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') runSync(false);
});
// And regularly while the page is in view, so links shared from the iPhone show up by themselves.
setInterval(() => {
  if (document.visibilityState === 'visible' && !dropboxBusy) runSync(false);
}, SYNC_EVERY_MS);
if (WEB) startDropboxSync(afterSync);

// Bare links (shared from the iPhone) get their details; then the picture copies follow.
async function afterSync() {
  if (!WEB) await fillDetails((url, spots) => readShopPage(url, spots)).catch(console.error);
  await syncThumbs().catch(console.error);
}

// Folder access is a Chromium feature; other browsers keep Export and Import only.
if ('showDirectoryPicker' in globalThis) {
  $('backup-menu').hidden = false;
  startBackup();
  refreshBackup().then(() => {
    if (backup.state === 'paused') toast(`Backup to “${backup.name}” is paused. Open the settings menu and choose Resume backup.`);
  });
}

function setSearch(open) {
  $('search-toggle').setAttribute('aria-expanded', String(open));
  document.querySelector('.topbar').classList.toggle('topbar--searching', open);
  if (open) {
    $('search').focus();
  } else if ($('search').value) {
    // Closing clears the query, so no hidden filter is left behind.
    $('search').value = '';
    setView({ query: '' });
  }
}

// Its own toggle and sheet (direct children): a menu may hold other menus, which close with it.
function setMenu(menu, open) {
  menu.querySelector(':scope > .menu__sheet').hidden = !open;
  menu.querySelector(':scope > .menu__toggle').setAttribute('aria-expanded', String(open));
  if (!open) for (const inner of menu.querySelectorAll('.menu')) setMenu(inner, false);
}

async function refresh() {
  state = await getState();
  // Shops kept as lists by older versions become the Shops rows; the change comes back here.
  if (hasOldShopLists(state.lists) && (await migrateShopLists())) return;
  if (view.listId !== UNSORTED && !state.lists.some((list) => list.id === view.listId) && !shopViewExists(view.listId)) view.listId = null;
  // Deleted items drop out of the selection.
  for (const id of selected) if (!state.products.some((p) => p.id === id)) selected.delete(id);
  render();
}

function setView(change) {
  Object.assign(view, change);
  render();
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}

// The text as nodes, with each match of the search wrapped in a <mark> so the results show
// where the phrase was found.
// Marks the searched words (not the commands, see search.js) in a piece of text.
function highlight(text = '') {
  const { words } = parseQuery(view.query);
  if (!words.length || !text) return [text];
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // With a capture group, split() puts the matches at the odd indexes.
  return text.split(new RegExp(`(${escaped})`, 'i')).map((part, index) => (index % 2 ? el('mark', { textContent: part }) : part));
}

// Items in a list or any of its sub-lists, each counted once.
function countIn(listId) {
  const branch = branchOf(state.lists, listId);
  return state.products.filter((p) => listsOf(p).some((id) => branch.has(id))).length;
}

// The lists and shops whose names match the search, in sidebar order: { id, path, name, count },
// path being the names of the places above it ("home", or "alza.sk" for a shop's list).
function matchingPlaces(words) {
  const above = (list) => {
    const names = [];
    const seen = new Set([list.id]);
    for (let parent = state.lists.find((l) => l.id === list.parentId); parent && !seen.has(parent.id); parent = state.lists.find((l) => l.id === parent.parentId)) {
      seen.add(parent.id);
      names.unshift(parent.name);
    }
    if (list.shop) names.unshift(list.shop);
    return names;
  };
  const places = [
    ...shopRows().flatMap((row) => (row.shop ? [{ id: row.id, path: [], name: row.name, count: row.count }] : row.list ? [{ id: row.id, path: above(row.list), name: row.name, count: row.count }] : [])),
    ...listTree(mainLists()).map(({ list }) => ({ id: list.id, path: above(list), name: list.name, count: countIn(list.id) })),
  ];
  return places.filter((place) => words.every((word) => place.name.toLowerCase().includes(word)));
}

function renderMatches() {
  const { words } = parseQuery(view.query);
  const found = words.length ? matchingPlaces(words) : [];
  // Redrawing drops the focus; it goes back to the same chip.
  const focused = document.activeElement?.closest?.('.matches__chip')?.dataset.id;
  $('matches').hidden = !found.length;
  $('matches-list').replaceChildren(
    ...found.map(({ id, path, name, count }) => {
      const chip = el(
        'button',
        { className: 'matches__chip', type: 'button', title: `Open ${[...path, name].join(' › ')}`, onclick: () => openPlace(id) },
        ...(path.length ? [el('span', { className: 'matches__path', textContent: `${path.join(' › ')} › ` })] : []),
        el('span', { className: 'matches__name' }, ...highlight(name)),
        el('span', { className: 'matches__count', textContent: count }),
      );
      chip.dataset.id = id;
      return chip;
    }),
  );
  if (focused) matchChips().find((chip) => chip.dataset.id === focused)?.focus();
}

// The keyboard through the search results: down from the search box goes to the matching
// lists (or straight to the cards), left and right move along the lists, down again goes to
// the cards and up back to the box; up from the top row of cards comes back to the lists.
function matchChips() {
  return $('matches').hidden ? [] : [...$('matches-list').querySelectorAll('.matches__chip')];
}

// The arrows also reach every control around the lists and the cards (the top bar, the
// heading rows), by where things are on screen: from a control, an arrow goes to the nearest
// thing in that direction, a control, a list, a chip or a card. Lists, chips and cards move
// among themselves as above and hand over here at their edges.
const CONTROLS = '.topbar :is(button, select, input, [role="button"]), .main-head :is(button, select), .sidebar__head :is(button, select)';

function shown(element) {
  return element.getClientRects().length > 0 && !element.disabled && !element.closest('[hidden], .menu__sheet');
}

// The nearest row (or column) in the arrow's direction first, then in it the closest thing
// to the side: up from a card goes to the heading row above it, not past it to the search.
// `pool`: the elements to pick from; by default the page's controls, lists, chips and cards.
function spatialTarget(from, key, pool = [...document.querySelectorAll(CONTROLS), ...matchChips(), ...navLinks(), ...$('grid').querySelectorAll(':scope > .card')]) {
  const box = from.getBoundingClientRect();
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const gap = (a1, a2, b1, b2) => Math.max(0, b1 - a2, a1 - b2);
  const candidates = [];
  for (const other of pool) {
    if (other === from || !shown(other)) continue;
    const rect = other.getBoundingClientRect();
    const along = {
      ArrowRight: rect.left - box.right,
      ArrowLeft: box.left - rect.right,
      ArrowDown: rect.top - box.bottom,
      ArrowUp: box.top - rect.bottom,
    }[key];
    if (along < -4) continue;
    const aside = horizontal ? gap(box.top, box.bottom, rect.top, rect.bottom) : gap(box.left, box.right, rect.left, rect.right);
    // Left and right stay on the same row.
    if (horizontal && aside > 0) continue;
    const centre = horizontal ? 0 : Math.abs(rect.left + rect.width / 2 - (box.left + box.width / 2));
    candidates.push({ other, along: Math.max(0, along), aside, centre });
  }
  if (!candidates.length) return null;
  const nearest = Math.min(...candidates.map((c) => c.along));
  const row = candidates.filter((c) => c.along <= nearest + 16);
  row.sort((a, b) => a.aside - b.aside || a.centre - b.centre || a.along - b.along);
  return row[0].other;
}

function goTo(target) {
  if (target.matches('#grid > .card')) focusCard(target);
  else if (target.matches('.matches__chip')) focusChip(target);
  else if (target === $('search')) focusSearch();
  else target.focus();
}

document.addEventListener('keydown', (event) => {
  if (!/^Arrow/.test(event.key) || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  if (document.querySelector('dialog[open], .menu__sheet:not([hidden])')) return;
  const from = event.target;
  if (from === $('search') || !from.matches?.(CONTROLS)) return;
  const target = spatialTarget(from, event.key);
  // A dropdown keeps its own arrows only when there is nowhere to go.
  if (!target) return;
  event.preventDefault();
  goTo(target);
});

// In an open ⋯ menu, up and down go through its items (round at the ends), from its toggle
// too. In a dialog, the arrows go to the nearest control that way, as on the page; text
// fields keep their arrows for the text. Enter on a dropdown opens it; inside it the arrows
// and Enter are the browser's.
const DIALOG_CONTROLS = 'button, select, a[href], input[type="checkbox"], input[type="radio"], [tabindex="0"]';

document.addEventListener('keydown', (event) => {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const from = event.target;
  if (event.key === 'Enter' && from.matches?.('dialog select, .settings select, #sort')) {
    event.preventDefault();
    try {
      from.showPicker();
    } catch {}
    return;
  }
  if (!/^Arrow/.test(event.key) || from.matches?.('textarea, input:not([type="checkbox"], [type="radio"], [type="button"]), [contenteditable]')) return;
  const sheet = [...document.querySelectorAll('.menu__sheet:not([hidden])')].find((open) => open.contains(from) || open.parentElement.querySelector(':scope > .menu__toggle') === from);
  if (sheet && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    const items = [...sheet.querySelectorAll(':scope > .menu__item, :scope .menu__item')].filter((item) => item.getClientRects().length && !item.closest('.menu__sheet[hidden]'));
    if (!items.length) return;
    const index = items.indexOf(from.closest('.menu__item'));
    const step = event.key === 'ArrowDown' ? 1 : -1;
    event.preventDefault();
    return items[index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length].focus();
  }
  const dialog = from.closest?.('dialog[open]');
  if (!dialog || sheet) return;
  const controls = [...dialog.querySelectorAll(DIALOG_CONTROLS)].filter(shown);
  // With the dialog itself focused (as it opens), the first arrow goes to its first control
  // (up: its last).
  const target = from === dialog ? controls[event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? controls.length - 1 : 0] : spatialTarget(from, event.key, controls);
  if (!target) return;
  event.preventDefault();
  target.focus();
});

// The search box; on small screens it is behind its icon, which opens it.
function focusSearch() {
  if (narrow.matches) setSearch(true);
  $('search').focus();
}

// The chips sit above the stuck heading row's bottom once the page has scrolled, so focusing
// one scrolls it back into sight below that row (scroll-margin in dashboard.css).
function focusChip(chip) {
  chip.focus({ preventScroll: true });
  chip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function firstCard() {
  return $('grid').querySelector(':scope > .card');
}

// Up from the cards comes back to the list chip used last.
let lastChip = null;
$('matches-list').addEventListener('focusin', (event) => {
  lastChip = event.target.closest('.matches__chip')?.dataset.id ?? lastChip;
});

function chipToReturnTo() {
  const chips = matchChips();
  return chips.find((chip) => chip.dataset.id === lastChip) ?? chips[0];
}

$('matches-list').addEventListener('keydown', (event) => {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const chips = matchChips();
  const index = chips.indexOf(event.target.closest('.matches__chip'));
  if (index < 0) return;
  let target = null;
  if (event.key === 'ArrowRight') target = chips[index + 1];
  // Left of the first chip: back to the open list in the sidebar.
  else if (event.key === 'ArrowLeft') target = chips[index - 1] ?? currentListLink();
  else if (event.key === 'Home') target = chips[0];
  else if (event.key === 'End') target = chips.at(-1);
  else if (event.key === 'ArrowUp') target = spatialTarget(event.target, 'ArrowUp') ?? $('search');
  else if (event.key === 'ArrowDown') {
    event.preventDefault();
    const card = firstCard();
    return card && focusCard(card);
  } else return;
  event.preventDefault();
  if (target) goTo(target);
});

// Opens a list or shop found by the search: the search closes, the sidebar unfolds down to
// it and shows it.
function openPlace(id) {
  const list = state.lists.find((l) => l.id === id);
  if (list?.shop || id.startsWith(SHOP)) {
    setCollapsed(SHOPS, false);
    setCollapsed(SHOP + (list?.shop ?? id.slice(SHOP.length)), false);
  }
  const seen = new Set();
  for (let parent = state.lists.find((l) => l.id === list?.parentId); parent && !seen.has(parent.id); parent = state.lists.find((l) => l.id === parent.parentId)) {
    seen.add(parent.id);
    setCollapsed(parent.id, false);
  }
  view.listId = id;
  setSearch(false);
  render();
  navLink(id)?.scrollIntoView({ block: 'nearest' });
}

// The names of an item's lists and of the lists they are inside, for the search: "home" finds
// the items in its sub-lists too.
function listNamesOf(product) {
  const names = new Set();
  for (const id of listsOf(product)) {
    const seen = new Set();
    for (let list = state.lists.find((l) => l.id === id); list && !seen.has(list.id); list = state.lists.find((l) => l.id === list.parentId)) {
      seen.add(list.id);
      names.add(list.name);
    }
  }
  return [...names];
}

function visibleProducts() {
  const tests = queryTests(parseQuery(view.query).parts);
  // A search naming a list ([home]) looks everywhere, not only in the open list.
  const listId = tests.everywhere ? null : view.listId;
  // A list shows its own items and those of its sub-lists; a Shops row, see inShop.
  const shopView = isShopView(listId);
  const branch = listId && listId !== UNSORTED && !shopView ? branchOf(state.lists, listId) : null;
  // Items only in Visited show in Visited, or when the search names it ([visited]).
  const pool = listId === VISITED_LIST_ID || tests.visited ? state.products : ownProducts();
  return pool
    .filter((p) => !listId || (shopView ? inShop(p, listId) : listId === UNSORTED ? !listsOf(p).length : listsOf(p).some((id) => branch.has(id))))
    .filter((p) => tests.every((test) => test(p)))
    .sort(SORTS[view.sort]);
}

// One test per part of the search (search.js); `everywhere` when one names a list.
function queryTests(parts) {
  const tests = parts.map((part) => {
    const test = partTest(part);
    return part.not ? (p) => !test(p) : test;
  });
  tests.everywhere = parts.some((part) => part.kind === 'list');
  const visited = visitedList()?.name.toLowerCase();
  tests.visited = Boolean(visited) && parts.some((part) => part.kind === 'list' && !part.not && visited.includes(part.name));
  return tests;
}

function partTest(part) {
  switch (part.kind) {
    case 'text':
      return (p) => [p.title, p.store, p.note, ...listNamesOf(p)].some((text) => text?.toLowerCase().includes(part.value));
    case 'list':
      return namedPlaceTest(part.name);
    case 'shop':
      return (p) => Boolean(p.store?.toLowerCase().includes(part.value));
    case 'price':
      return (p) => {
        const price = shownPrice(p);
        return price != null && part.test(price);
      };
    case 'has':
      return (p) => ({ note: Boolean(p.note?.trim()), price: p.price != null, picture: Boolean(p.image), list: listsOf(p).length > 0 })[part.flag];
    case 'change':
      return (p) => {
        const change = priceChange(p);
        return Boolean(change) && (part.down ? change.percent < 0 : change.percent > 0);
      };
  }
  return () => true;
}

// [name]: the lists and shops with that name (any case), or when none has it exactly, those
// whose names contain it; an item matches when it is in one of them (sub-lists included).
function namedPlaceTest(name) {
  if (name === 'all') return () => true;
  if (name === 'unsorted' || name === NO_LIST_NAME.toLowerCase()) return (p) => !listsOf(p).length;
  const pick = (names, exact) => names.filter((other) => (exact ? other.toLowerCase() === name : other.toLowerCase().includes(name)));
  const exact = pick(state.lists.map((l) => l.name), true).length + pick(shopNames(), true).length > 0;
  const lists = state.lists.filter((list) => pick([list.name], exact).length);
  const ids = new Set(lists.flatMap((list) => [...branchOf(state.lists, list.id)]));
  const shops = pick(shopNames(), exact).map((shop) => SHOP + shop);
  return (p) => listsOf(p).some((id) => ids.has(id)) || shops.some((shop) => inShop(p, shop));
}

// An item's price in the currency the prices are shown in (the settings' currency).
function shownPrice(product) {
  const inEuro = euros(product);
  if (inEuro == null) return null;
  return state.currency === 'EUR' ? inEuro : inEuro * (rates[state.currency] ?? NaN);
}

function render() {
  const products = visibleProducts();
  const currentList = state.lists.find((list) => list.id === view.listId);
  const unsortedCount = state.products.filter((p) => !listsOf(p).length).length;

  // Rebuilding the rows drops the focus; it goes back to the same list (or its chevron), so
  // the keyboard and a click carry on from there.
  const focused = document.activeElement?.closest?.('#lists .list-row');
  const refocus = focused && {
    nav: focused.querySelector('.list-link').dataset.nav,
    chevron: document.activeElement.classList.contains('list-chevron'),
  };
  // A name being edited in place keeps its rows until it is done (renameInPlace).
  if (!renaming) $('lists').replaceChildren(
    listLink(null, 'All Items', ownProducts().length),
    listLink(UNSORTED, NO_LIST_NAME, unsortedCount),
    ...(visitedList() ? [listLink(VISITED_LIST_ID, visitedList().name, countIn(VISITED_LIST_ID))] : []),
    ...shopRows(collapsedLists).map(shopRow),
    // A line between the fixed places and the user's own lists.
    ...(mainLists().length ? [el('hr', { className: 'sidebar__divider' })] : []),
    ...listTree(mainLists(), collapsedLists).map(({ list, depth, hasChildren }) => listLink(list.id, list.name, countIn(list.id), { depth, hasChildren })),
    trashLink(),
  );
  // One tab stop for the whole tree, on the open list; arrows move from there.
  const links = navLinks();
  for (const link of links) link.tabIndex = -1;
  (links.find((link) => link.getAttribute('aria-current') === 'true') ?? links[0]).tabIndex = 0;
  if (refocus) {
    const row = navLink(refocus.nav)?.closest('.list-row');
    const chevron = refocus.chevron && row?.querySelector('.list-chevron');
    (chevron || row?.querySelector('.list-link'))?.focus();
  }
  // Small screens pick the list from a dropdown instead of the row of tabs.
  $('list-picker').replaceChildren(
    new Option(`All Items (${ownProducts().length})`, ''),
    new Option(`${NO_LIST_NAME} (${unsortedCount})`, UNSORTED),
    ...(visitedList() ? [new Option(`${visitedList().name} (${countIn(VISITED_LIST_ID)})`, VISITED_LIST_ID)] : []),
    ...shopRows().map((row) => new Option(`${'\u00a0\u00a0\u00a0'.repeat(row.depth)}${row.name} (${row.count})`, row.id)),
    ...listTree(mainLists()).map(({ list, depth }) => new Option(`${'\u00a0\u00a0\u00a0'.repeat(depth)}${list.name} (${countIn(list.id)})`, list.id)),
    document.createElement('hr'),
    new Option('New list', NEW_LIST),
  );
  $('list-picker').value = view.listId ?? '';
  $('currency').value = state.currency;

  $('lists-title').textContent = `Lists (${mainLists().length})`;
  // The sidebar already shows which list is open; the heading counts what is shown.
  // With cards ticked, the heading row is about the selection instead of the list.
  const selecting = selected.size > 0;
  $('list-title').textContent = selecting ? `Selected items (${selected.size})` : `Saved items (${products.length})`;
  document.querySelector('.main-head').classList.toggle('main-head--selecting', selecting);
  // One button: selects every shown card, or, once they all are, clears the selection.
  const allShown = products.length > 0 && products.every((p) => selected.has(p.id));
  $('select-toggle').hidden = !selecting;
  $('delete-selected').hidden = !selecting;
  $('select-toggle').textContent = allShown ? 'Select none' : 'Select all';
  $('list-menu').hidden = !currentList || selecting;

  renderMatches();
  const before = Date.now() < animateGridUntil ? cardPositions() : null;
  const key = `${view.listId}|${view.query}|${view.sort}`;
  if (key !== shownKey) {
    shownKey = key;
    shownCount = BATCH;
  }
  const cardFocused = document.activeElement?.matches?.('#grid > .card');
  $('grid').replaceChildren(...products.slice(0, shownCount).map(card));
  // One tab stop for the cards, on the last one used; the focus stays on it across redraws.
  const cards = [...$('grid').children];
  for (const c of cards) c.tabIndex = -1;
  const current = cards.find((c) => c.dataset.id === currentCardId) ?? cards[0];
  if (current) current.tabIndex = 0;
  if (cardFocused && current) current.focus({ preventScroll: true });
  // Once any card is ticked, every card shows its checkbox and grip.
  $('grid').classList.toggle('grid--selecting', selected.size > 0);
  $('grid').classList.toggle('grid--list', view.layout === 'list');
  $('grid').classList.toggle('grid--compact', view.layout === 'compact');
  $('grid').dataset.pictures = pictures;
  // The view picker shows the icon of the view in use, and its menu ticks it.
  $('view-field').dataset.layout = view.layout;
  $('view-select').value = view.layout;
  for (const option of document.querySelectorAll('.view-option')) option.setAttribute('aria-checked', String(option.dataset.layout === view.layout));
  if (before) rearrange(before);
  if (nearEnd()) showMore();
  $('empty').hidden = products.length > 0;
  $('empty').textContent = state.products.length
    ? 'Nothing here matches.'
    : 'Nothing saved yet. Open a product page in any online shop and click the ShopMarx icon in the toolbar.';
}

// depth: how far down the tree the list is; hasChildren: it has sub-lists, so it gets a
// chevron that folds them away.
function listLink(id, name, count, { depth = 0, hasChildren = false } = {}) {
  const link = el(
    'button',
    { className: 'list-link', type: 'button', onclick: () => clickList(id) },
    el('span', { className: 'list-link__name', textContent: name }),
    el('span', { className: 'list-link__count', textContent: count }),
  );
  link.setAttribute('aria-current', String(view.listId === id));
  link.dataset.nav = id ?? '';
  // Lists and Unsorted take dropped cards; All Items and Shops are not places to move to.
  if (id !== null && !isShopView(id)) {
    link.dataset.listId = id;
    link.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE) || link.classList.contains('list-link--disabled')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      link.classList.add('list-link--drop');
    });
    link.addEventListener('dragleave', (event) => {
      if (!link.contains(event.relatedTarget)) link.classList.remove('list-link--drop');
    });
    link.addEventListener('drop', (event) => {
      event.preventDefault();
      link.classList.remove('list-link--drop');
      const ids = event.dataTransfer.getData(DRAG_TYPE).split(',');
      if (id === TRASH) deleteItems(ids);
      else moveToList(ids, id, name);
    });
  }
  // A row: the link, and for the user's lists a ⋯ menu that shows on hover.
  const row = el('div', { className: 'list-row' }, link);
  row.style.setProperty('--depth', depth);
  if (hasChildren) {
    const open = !collapsedLists.has(id);
    const chevron = el('button', {
      className: 'list-chevron',
      type: 'button',
      title: open ? 'Hide sub-lists' : 'Show sub-lists',
      ariaLabel: `${open ? 'Hide' : 'Show'} the sub-lists of ${name}`,
      innerHTML: ICONS.chevron,
      onclick: () => {
        setCollapsed(id, open);
        render();
      },
    });
    chevron.setAttribute('aria-expanded', String(open));
    row.prepend(chevron);
  }
  const list = state.lists.find((l) => l.id === id);
  if (list?.id === VISITED_LIST_ID) {
    row.append(rowMenu(list.name, [['Forget visited items', ICONS.delete, forgetVisited, 'Delete the items that are only in Visited; items you put in your own lists stay', 'menu__item--danger']], 'Visited actions'));
  } else if (list?.shop) {
    row.append(shopListMenu(list));
  } else if (list) {
    // Only a hint: the whole row drags (makeListDraggable), the grip shows where to grab it.
    row.prepend(el('span', { className: 'list-grip', title: 'Drag to move', innerHTML: ICONS.grip, ariaHidden: 'true' }));
    row.append(listMenu(list));
    makeListDraggable(row, list.id);
  }
  return row;
}

// Renaming a list right in its row: the name becomes a field. Enter or leaving the field
// saves, Escape keeps the old name; a name another list has is refused, as in the dialog.
// While it is open the sidebar is not redrawn, so the field stays.
let renaming = false;
let lastClick = { id: null, at: 0 };

// A click opens the list; a second click on the same list soon after (a double click) edits
// its name. Counted here, not with dblclick: the first click redraws the sidebar, so the two
// clicks land on different elements.
function clickList(id) {
  const again = lastClick.id === id && Date.now() - lastClick.at < 500;
  lastClick = { id, at: again ? 0 : Date.now() };
  const list = state.lists.find((l) => l.id === id);
  if (again && list) return renameInPlace(navLink(id).closest('.list-row'), list);
  setView({ listId: id });
}

function renameInPlace(row, list) {
  if (renaming) return;
  const link = row.querySelector('.list-link');
  const input = el('input', { className: 'input list-row__edit', value: list.name, maxLength: 60, ariaLabel: `New name for ${list.name}` });
  renaming = true;
  // Selecting text with the pointer must not drag the row.
  row.draggable = false;
  link.hidden = true;
  link.after(input);
  input.focus();
  input.select();
  let done = false;
  // leaving: the field lost the focus; a taken name then keeps the old one instead.
  const finish = async (save, leaving = false) => {
    if (done) return;
    const name = input.value.trim();
    const taken = save && name && listNamed(state.lists, name, list.id);
    if (taken) toast(`There is already a list called “${taken.name}”.`);
    if (taken && !leaving) return input.select();
    if (taken) save = false;
    done = true;
    renaming = false;
    if (save && name && name !== list.name) await track(() => renameList(list.id, name));
    render();
    navLink(list.id)?.focus();
  };
  // Keys typed here are the field's own, not the sidebar's or the page's shortcuts.
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true, true));
  for (const type of ['click', 'dblclick', 'pointerdown', 'dragstart']) input.addEventListener(type, (event) => event.stopPropagation());
}

// The sidebar's lists as a tree for the keyboard: up and down open the list above or below,
// right unfolds a list's sub-lists or steps into them, left folds them or steps out to the
// parent list, Home and End go to the first and last.
function navLinks() {
  return [...$('lists').querySelectorAll('.list-link:not(.list-link--trash)')];
}

function navLink(nav) {
  return navLinks().find((link) => link.dataset.nav === nav);
}

$('lists').addEventListener('keydown', (event) => {
  const link = event.target.closest('.list-link');
  if (link) listKey(link, event);
});

function listKey(link, event) {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const links = navLinks();
  const index = links.indexOf(link);
  if (index < 0) return;
  const id = link.dataset.nav || null;
  const folds = Boolean(link.closest('.list-row').querySelector('.list-chevron'));
  const open = folds && !collapsedLists.has(id);
  let target = null;
  switch (event.key) {
    case 'ArrowDown':
      target = links[index + 1];
      break;
    case 'ArrowUp':
      target = links[index - 1];
      // Above the first list: the controls over the sidebar.
      if (!target) {
        const above = spatialTarget(link, 'ArrowUp');
        if (above) {
          event.preventDefault();
          return goTo(above);
        }
      }
      break;
    case 'F2': {
      const list = state.lists.find((l) => l.id === id);
      if (!list) return;
      event.preventDefault();
      return renameInPlace(link.closest('.list-row'), list);
    }
    case 'Home':
      target = links[0];
      break;
    case 'End':
      target = links.at(-1);
      break;
    case 'ArrowRight':
      if (folds && !open) {
        event.preventDefault();
        setCollapsed(id, false);
        return render();
      }
      if (open) target = links[index + 1];
      // Nothing to unfold or step into: on to the cards, or the list chips when a search
      // shows no cards.
      else {
        const next = currentCard() ?? chipToReturnTo();
        if (!next) return;
        event.preventDefault();
        return goTo(next);
      }
      break;
    case 'ArrowLeft':
      if (open) {
        event.preventDefault();
        setCollapsed(id, true);
        return render();
      }
      target = navLink(link.dataset.parent ?? state.lists.find((list) => list.id === id)?.parentId ?? '\0');
      break;
    default:
      return;
  }
  event.preventDefault();
  if (!target) return;
  target.focus();
  setView({ listId: target.dataset.nav || null });
}

// The cards for the keyboard: arrows move between them (up and down by row in the grid),
// Enter opens the shop page, Space ticks the card.
function cardKey(article, event) {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const cards = [...$('grid').querySelectorAll(':scope > .card')];
  const index = cards.indexOf(article);
  let target = null;
  switch (event.key) {
    case 'ArrowRight':
      target = cards[index + 1];
      break;
    case 'ArrowLeft':
      // From the first card of a row, out to the open list in the sidebar.
      if (article.offsetLeft === cards[0].offsetLeft && currentListLink()) {
        event.preventDefault();
        return currentListLink().focus();
      }
      target = cards[index - 1];
      break;
    case 'ArrowDown':
    case 'ArrowUp': {
      // A row is the cards that share a top edge; a column is found by left edge.
      const columns = Math.max(1, cards.filter((c) => c.offsetTop === cards[0].offsetTop).length);
      target = cards[index + (event.key === 'ArrowDown' ? columns : -columns)];
      // Up from the top row: to the matching lists while searching, or the search box.
      if (!target && event.key === 'ArrowUp' && article.offsetTop === cards[0].offsetTop) {
        event.preventDefault();
        const chip = chipToReturnTo();
        const above = chip ?? spatialTarget(article, 'ArrowUp');
        return above ? goTo(above) : focusSearch();
      }
      if (!target && event.key === 'ArrowDown' && Math.floor(index / columns) < Math.floor((cards.length - 1) / columns)) target = cards.at(-1);
      break;
    }
    case 'Home':
      target = cards[0];
      break;
    case 'End':
      target = cards.at(-1);
      break;
    case 'Enter':
      event.preventDefault();
      return article.querySelector('.card__title a').click();
    case ' ':
      event.preventDefault();
      return article.querySelector('.card__select').click();
    default:
      return;
  }
  event.preventDefault();
  if (target) focusCard(target);
}

let currentCardId = null;

function focusCard(article) {
  for (const other of $('grid').querySelectorAll(':scope > .card[tabindex="0"]')) other.tabIndex = -1;
  article.tabIndex = 0;
  currentCardId = article.dataset.id;
  article.focus({ preventScroll: true });
  // Whole, with a gap: below the stuck rows going up, above the window's edge going down.
  article.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('grid').addEventListener('keydown', (event) => {
  if (event.target.matches('.card')) cardKey(event.target, event);
});
$('grid').addEventListener('focusin', (event) => {
  if (event.target.matches('.card')) currentCardId = event.target.dataset.id;
});

// Tab goes back and forth between the two: from the open list to the cards and back, and
// the arrows work in whichever has the focus. With nothing focused (as after loading), the
// arrows and Tab start in the lists. Inside a card's own buttons, or in fields, Tab is as usual.
function currentListLink() {
  return navLinks().find((link) => link.tabIndex === 0);
}

function currentCard() {
  const cards = [...$('grid').querySelectorAll(':scope > .card')];
  return cards.find((c) => c.dataset.id === currentCardId) ?? cards[0];
}

document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open], .menu__sheet:not([hidden])')) return;
  const active = document.activeElement;
  const nothing = !active || active === document.body;
  // Tab goes round the three places: the lists, the cards, the search box, and back to the
  // lists (Shift+Tab the other way); a place with nothing in it is skipped.
  if (event.key === 'Tab' && !event.altKey && !event.metaKey && !event.ctrlKey) {
    const places = ['lists', 'cards', 'search'];
    const here = active?.matches?.('#lists .list-link') ? 0 : active?.matches?.('#grid > .card') ? 1 : active === $('search') || active?.matches?.('.matches__chip') ? 2 : nothing ? -1 : null;
    if (here === null) return;
    const step = event.shiftKey ? -1 : 1;
    // With nothing focused, Tab starts at the lists and Shift+Tab at the search box.
    const start = here >= 0 ? here : event.shiftKey ? 0 : places.length - 1;
    for (let turn = 1; turn <= places.length; turn += 1) {
      const place = places[(start + step * turn + places.length) % places.length];
      if (place === 'lists' && currentListLink()) {
        event.preventDefault();
        return currentListLink().focus();
      }
      if (place === 'cards' && currentCard()) {
        event.preventDefault();
        return focusCard(currentCard());
      }
      if (place === 'search') {
        event.preventDefault();
        return focusSearch();
      }
    }
    return;
  }
  if (nothing && /^(Arrow|Home$|End$)/.test(event.key)) {
    const link = currentListLink();
    if (!link) return;
    link.focus();
    listKey(link, event);
  }
});

// Your own lists can be dragged up or down the sidebar and to any level. The pointer's
// height picks the gap between two rows (the upper or lower half of a row); moving it left or
// right, LEVEL_STEP per level from where the drag started, picks the level, shown by the
// line's indent. A gap allows every level from the row below's (anything shallower would cut
// that row off from its parent) to one deeper than the row above (its first sub-list).
const LEVEL_STEP = 24;
let draggedList = null; // dataTransfer cannot be read until the drop, so the id is kept here.
let dragStartX = 0;
let dragDepth = 0;

// Where a drag over `row` would put the dragged list: { above, below } (the rows around the
// gap, by id, either may be missing) and { depth, parentId }. Null when it cannot go there.
function listDropAt(row, event) {
  const moved = draggedList;
  if (!moved) return null;
  const branch = branchOf(state.lists, moved);
  const rows = listTree(mainLists(), collapsedLists);
  const index = rows.findIndex(({ list }) => list.id === row.dataset.id);
  if (index === -1) return null;
  // Over the dragged list or its sub-lists, the gap is where the list is now.
  const box = row.getBoundingClientRect();
  const lower = event.clientY > box.top + box.height / 2;
  let gap; // How many of the other rows are above the gap.
  const others = rows.filter(({ list }) => !branch.has(list.id));
  if (branch.has(row.dataset.id)) {
    gap = rows.slice(0, rows.findIndex(({ list }) => list.id === moved)).filter(({ list }) => !branch.has(list.id)).length;
  } else {
    gap = others.findIndex(({ list }) => list.id === row.dataset.id) + (lower ? 1 : 0);
  }
  const above = others[gap - 1];
  const below = others[gap];
  const deepest = above ? above.depth + 1 : 0;
  const shallowest = below ? below.depth : 0;
  const wanted = dragDepth + Math.round((event.clientX - dragStartX) / LEVEL_STEP);
  const depth = Math.max(shallowest, Math.min(deepest, wanted));
  // The parent: the row above itself, or the one of its ancestors a level above `depth`.
  let parentId = null;
  if (depth > 0) {
    let id = above.list.id;
    for (let level = above.depth; level >= depth; level -= 1) id = state.lists.find((l) => l.id === id)?.parentId;
    parentId = id ?? null;
  }
  return { above: above?.list.id ?? null, below: below?.list.id ?? null, depth, parentId };
}

function clearListDrop() {
  for (const marked of document.querySelectorAll('.list-row[data-drop]')) {
    delete marked.dataset.drop;
    marked.style.removeProperty('--drop-depth');
  }
}

function makeListDraggable(row, id) {
  row.draggable = true;
  row.dataset.id = id;
  row.addEventListener('dragstart', (event) => {
    if (event.target !== row) return;
    event.dataTransfer.setData(LIST_DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = 'move';
    row.classList.add('list-row--dragging');
    draggedList = id;
    dragStartX = event.clientX;
    dragDepth = listTree(mainLists()).find(({ list }) => list.id === id)?.depth ?? 0;
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('list-row--dragging');
    clearListDrop();
    draggedList = null;
  });
  row.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes(LIST_DRAG_TYPE)) return;
    const drop = listDropAt(row, event);
    if (!drop) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    // The line: under the row above the gap, or over the first row when the gap is at the top.
    const marked = $('lists').querySelector(`.list-row[data-id="${drop.above ?? drop.below}"]`);
    const place = drop.above ? 'after' : 'before';
    if (marked?.dataset.drop === place && marked.style.getPropertyValue('--drop-depth') === String(drop.depth)) return;
    clearListDrop();
    if (!marked) return;
    marked.dataset.drop = place;
    marked.style.setProperty('--drop-depth', drop.depth);
  });
  row.addEventListener('drop', (event) => {
    const moved = event.dataTransfer.getData(LIST_DRAG_TYPE);
    if (!moved) return;
    event.preventDefault();
    const drop = listDropAt(row, event);
    clearListDrop();
    if (!drop) return;
    // Right after the row above the gap (before the row below at the very top); its new
    // parent opens so it shows there.
    const ids = listTree(mainLists()).map(({ list }) => list.id).filter((listId) => listId !== moved);
    ids.splice(drop.above ? ids.indexOf(drop.above) + 1 : drop.below ? ids.indexOf(drop.below) : ids.length, 0, moved);
    if (drop.parentId) setCollapsed(drop.parentId, false);
    track(() => reorderLists(ids, moved, drop.parentId));
  });
}

// True when the list is a sub-list of a list that exists.
function hasParent(id) {
  const parentId = state.lists.find((l) => l.id === id)?.parentId;
  return Boolean(parentId && state.lists.some((l) => l.id === parentId));
}

// Puts a list under parentId (null: top level): right after `afterId`'s whole branch, or,
// without one, last among the parent's sub-lists (last at the top level).
function moveList(moved, parentId, afterId = null) {
  const ids = listTree(mainLists()).map(({ list }) => list.id).filter((listId) => listId !== moved);
  const anchor = afterId ?? parentId;
  const branch = anchor ? [...branchOf(state.lists, anchor)].filter((listId) => listId !== moved) : [];
  ids.splice(branch.length ? Math.max(...branch.map((listId) => ids.indexOf(listId))) + 1 : ids.length, 0, moved);
  if (parentId) setCollapsed(parentId, false);
  return track(() => reorderLists(ids, moved, parentId));
}

// Move to…: the same as dragging, for phones and the keyboard.
async function moveListDialog(list) {
  $('move-title').textContent = `Move “${list.name}”`;
  const branch = branchOf(state.lists, list.id);
  const select = $('move-parent');
  select.replaceChildren(
    new Option('Top level', ''),
    ...listTree(mainLists())
      .filter(({ list: other }) => !branch.has(other.id))
      .map(({ list: other, depth }) => new Option(`${'\u2003'.repeat(depth)}${other.name}`, other.id)),
  );
  select.value = hasParent(list.id) ? list.parentId : '';
  if (!(await ask($('move-dialog')))) return;
  const parentId = select.value || null;
  if ((hasParent(list.id) ? list.parentId : null) === parentId) return;
  await moveList(list.id, parentId);
  toast(`Moved “${list.name}” ${parentId ? `into “${state.lists.find((l) => l.id === parentId)?.name}”` : 'to the top level'}.`);
}

// The ⋯ menu of one list: add a sub-list, rename, move, or remove it.
function listMenu(list) {
  return rowMenu(list.name, [
    ['Add sub-list', ICONS.subList, () => addSubList(list), 'Create a list inside this one'],
    ...sortItem(list.id, null, list.name),
    ['Rename', ICONS.edit, () => renameListDialog(list), 'Rename this list'],
    ['Move to…', ICONS.move, () => moveListDialog(list), 'Put this list inside another one, or at the top level'],
    ['Remove', ICONS.delete, () => removeListDialog(list), `Remove this list; you choose where its items go (${NO_LIST_NAME} or another list)`, 'menu__item--danger'],
  ], 'List actions');
}

// Shops

function isShopView(id) {
  return id === SHOPS || Boolean(id?.startsWith(SHOP));
}

function shopViewExists(id) {
  if (id === SHOPS) return true;
  if (id?.startsWith(SHOP)) return shopNames().includes(id.slice(SHOP.length));
  return false;
}

// Every shop with an item or a list, by name.
function shopNames() {
  return [...new Set([...ownProducts().map((p) => p.store), ...state.lists.map((l) => l.shop)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// The ids of a shop's lists, at any depth.
function shopListIds(shop) {
  return new Set(state.lists.filter((list) => list.shop === shop).map((list) => list.id));
}

// Whether an item shows under a Shops row: every item under Shops; under a shop, the items
// from that shop and the items in the shop's lists.
function inShop(product, id) {
  if (id === SHOPS) return true;
  const shop = id.slice(SHOP.length);
  if (product.store === shop) return true;
  const ids = shopListIds(shop);
  return listsOf(product).some((listId) => ids.has(listId));
}

// The Shops rows in sidebar order: Shops, then each shop with its lists (as a tree) under it.
// Rows under a row in `collapsed` are left out.
function shopRows(collapsed = new Set()) {
  const shops = shopNames();
  if (!shops.length) return [];
  const count = (id) => ownProducts().filter((p) => inShop(p, id)).length;
  const rows = [{ id: SHOPS, name: 'Shops', depth: 0, hasChildren: true, count: ownProducts().length }];
  if (collapsed.has(SHOPS)) return rows;
  for (const shop of shops) {
    const id = SHOP + shop;
    const lists = state.lists.filter((list) => list.shop === shop);
    rows.push({ id, name: shop, shop, depth: 1, parent: SHOPS, hasChildren: lists.length > 0, count: count(id) });
    if (collapsed.has(id)) continue;
    for (const { list, depth, hasChildren } of listTree(lists, collapsed)) {
      const parent = lists.some((l) => l.id === list.parentId) ? list.parentId : id;
      rows.push({ id: list.id, name: list.name, list, depth: depth + 2, parent, hasChildren, count: countIn(list.id) });
    }
  }
  return rows;
}

function shopRow({ id, name, count, depth, parent, hasChildren, shop }) {
  const row = listLink(id, name, count, { depth, hasChildren });
  const link = row.querySelector('.list-link');
  if (parent) link.dataset.parent = parent;
  if (shop) {
    row.append(
      rowMenu(name, [['Add sub-list', ICONS.subList, () => addShopList(shop), `Create a list in ${shop}, to sort its items`], ...sortItem(null, shop, shop)], 'Shop actions'),
    );
  }
  return row;
}

// A shop's list: add a list inside it, rename or remove it. It stays with its shop.
function shopListMenu(list) {
  return rowMenu(list.name, [
    ['Add sub-list', ICONS.subList, () => addShopList(list.shop, list), 'Create a list inside this one'],
    ...sortItem(list.id, list.shop, list.name),
    ['Rename', ICONS.edit, () => renameListDialog(list), 'Rename this list'],
    ['Remove', ICONS.delete, () => removeListDialog(list), `Remove this list; you choose where its items go (${NO_LIST_NAME} or another list)`, 'menu__item--danger'],
  ], 'List actions');
}

// The sub-lists of a list (parentId), or with parentId null a shop's own top lists.
function subLists(parentId, shop) {
  return state.lists.filter((list) => (parentId ? hasParent(list.id) && list.parentId === parentId : !hasParent(list.id) && list.shop === shop));
}

// "Sort sub-lists A–Z" for a menu, once there are two or more to sort.
function sortItem(parentId, shop, name) {
  if (subLists(parentId, shop).length < 2) return [];
  return [['Sort sub-lists A–Z', ICONS.sortAz, () => sortSubLists(parentId, shop, name), `Put the lists inside ${name} in alphabetical order`]];
}

// Puts the sub-lists in A–Z order; every other list keeps its place. Lists keep their order
// through their positions (reorderLists), so the sub-lists trade places in the whole order.
async function sortSubLists(parentId, shop, name) {
  const order = listTree(state.lists).map(({ list }) => list);
  const siblings = new Set(subLists(parentId, shop).map((list) => list.id));
  const sorted = order
    .filter((list) => siblings.has(list.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  let next = 0;
  const ids = order.map((list) => (siblings.has(list.id) ? sorted[next++] : list).id);
  await track(() => reorderLists(ids));
  toast(`Sorted the lists in “${name}” A–Z.`);
}

async function addShopList(shop, parent = null) {
  const name = await askName(`Add new list in “${parent?.name ?? shop}”`);
  if (!name) return;
  // Open the way down to it, so the new list shows.
  setCollapsed(SHOPS, false);
  setCollapsed(SHOP + shop, false);
  if (parent) setCollapsed(parent.id, false);
  const list = await track(() => createList(name, parent?.id ?? null, shop));
  view.listId = list.id;
  refresh();
}

// A ⋯ menu for a sidebar row: items are [label, icon, onclick, tip, modifier].
function rowMenu(name, items, title = 'Actions') {
  const toggle = el('button', {
    className: 'button button--ghost menu__toggle list-link__more',
    type: 'button',
    title,
    ariaLabel: `Actions for ${name}`,
    innerHTML: ICONS.more,
  });
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  const sheet = el(
    'div',
    { className: 'menu__sheet', role: 'menu', hidden: true },
    ...items.map(([label, icon, onclick, tip, modifier = '']) =>
      el('button', { className: `menu__item ${modifier}`.trim(), type: 'button', role: 'menuitem', title: tip, innerHTML: `${icon}<span class="menu__label">${label}</span>`, onclick }),
    ),
  );
  return el('div', { className: 'menu list-link__menu' }, toggle, sheet);
}

function trashLink() {
  const row = listLink(TRASH, 'Trash', '');
  const link = row.querySelector('.list-link');
  link.classList.add('list-link--trash');
  link.onclick = null;
  link.tabIndex = -1;
  return row;
}

// Deletes for good after asking; used by the Trash drop target and Delete selected.
async function deleteItems(ids) {
  const products = state.products.filter((p) => ids.includes(p.id));
  if (!products.length) return;
  const title = products.length === 1 ? 'Delete this item?' : `Delete ${products.length} items?`;
  const text = products.length === 1 ? `${products[0].title}\n\nThis deletes it for good.` : 'This deletes them for good.';
  if (!(await confirmAction(title, text))) return;
  animateGridUntil = Date.now() + 1000;
  await track(async () => {
    for (const product of products) {
      await removeProduct(product.id);
      selected.delete(product.id);
    }
  }, products.length === 1 ? 'Deleted.' : `Deleted ${products.length} items.`);
}

// Undo and redo. Every change made here runs through track, which notes how the items and
// lists it touched were before and after; Cmd+Z (Ctrl+Z) puts the last change back and
// Cmd+Shift+Z (Ctrl+Y) makes it again. A change made inside another one is part of it.
// Kept for this page only; changes from other devices are not undone.
const UNDO_STEPS = 50;
const undoSteps = [];
const redoSteps = [];
let tracking = 0;

// Runs a change and keeps it as one step; with `message`, its toast offers Undo.
async function track(change, message) {
  if (tracking) return change();
  tracking += 1;
  let before;
  let result;
  try {
    before = await syncData();
    result = await change();
  } finally {
    tracking -= 1;
  }
  const step = stepBetween(before, await syncData());
  if (step) {
    undoSteps.push(step);
    if (undoSteps.length > UNDO_STEPS) undoSteps.shift();
    redoSteps.length = 0;
  }
  if (message) toast(message, step ? { action: 'Undo', run: () => undo(step) } : {});
  return result;
}

// The records a change touched, as they were before and after it (missing: not there).
function stepBetween(before, after) {
  const step = { before: {}, after: {} };
  let changed = false;
  for (const key of ['products', 'lists']) {
    const was = new Map(before[key].map((record) => [record.id, record]));
    const now = new Map(after[key].map((record) => [record.id, record]));
    const ids = [...new Set([...was.keys(), ...now.keys()])].filter((id) => JSON.stringify(was.get(id)) !== JSON.stringify(now.get(id)));
    step.before[key] = ids.map((id) => [id, was.get(id)]);
    step.after[key] = ids.map((id) => [id, now.get(id)]);
    changed ||= ids.length > 0;
  }
  return changed ? step : null;
}

// Makes the records as `side` has them: puts those it holds back, deletes those it lacks.
function applySide(side) {
  const put = {};
  const remove = {};
  for (const key of ['products', 'lists']) {
    put[key] = side[key].filter(([, record]) => record).map(([, record]) => record);
    remove[key] = side[key].filter(([, record]) => !record).map(([id]) => id);
  }
  animateGridUntil = Date.now() + 1000;
  return restoreRecords(put, remove);
}

// `step`: a particular one (from a toast's Undo); it must still be the last one done.
async function undo(step = undoSteps.at(-1)) {
  if (!step) return toast('Nothing to undo.');
  if (undoSteps.at(-1) !== step) return toast(`Something changed since; press ${MOD_KEY}+Z to go back step by step.`);
  undoSteps.pop();
  await applySide(step.before);
  redoSteps.push(step);
  toast('Undone.', { action: 'Redo', run: redo });
}

async function redo() {
  const step = redoSteps.pop();
  if (!step) return toast('Nothing to redo.');
  await applySide(step.after);
  undoSteps.push(step);
  toast('Redone.', { action: 'Undo', run: () => undo(step) });
}

// In a text field the browser's own undo works on the text instead.
document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  const redoKey = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
  if (!(key === 'z' && !event.shiftKey) && !redoKey) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (redoKey) redo();
  else undo();
});

// A card dropped on a list moves out of the list being viewed and into that one; from All
// Items or Unsorted it is added, keeping its other lists. Dropped on Unsorted, it leaves
// every list.
async function moveToList(productIds, listId, name) {
  const fromList = view.listId && view.listId !== UNSORTED;
  // Each update redraws the grid; let those redraws animate.
  animateGridUntil = Date.now() + 1000;
  let changed = 0;
  await track(async () => {
    for (const product of state.products.filter((p) => productIds.includes(p.id))) {
      const current = listsOf(product);
      let next;
      if (listId === UNSORTED) next = [];
      else if (fromList) next = [...new Set([...current.filter((id) => id !== view.listId), listId])];
      else next = [...new Set([...current, listId])];
      if (next.length === current.length && next.every((id) => current.includes(id))) continue;
      await updateProduct(product.id, { listIds: next });
      changed += 1;
    }
  });
  if (!changed) return toast(`Already in “${name}”.`);
  selected.clear();
  render();
  const what = changed === 1 ? '' : ` ${changed} items`;
  toast(listId === UNSORTED ? `Moved${what} to Unsorted.` : `${fromList ? 'Moved' : 'Added'}${what} to “${name}”.`);
}

function card(product) {
  const change = priceChange(product);
  const link = { href: product.url, target: '_blank', rel: 'noopener' };
  const image = el('a', { ...link, className: 'card__image', ariaLabel: product.title });
  // No picture, or one that fails to load: the shop's name on the shop's own colour.
  const showPlaceholder = () => {
    image.classList.add('card__image--empty');
    image.style.setProperty('--hue', hueOf(product.store));
    image.replaceChildren(product.store || 'No image');
  };
  if (product.image) {
    // This device's copy when there is one, else straight from the shop.
    const src = thumbFor(product.image) ?? product.image;
    // The same picture twice: blurred to fill the area behind, and whole on top.
    const picture = el('img', { src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onerror: showPlaceholder });
    image.append(el('img', { className: 'card__backdrop', src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', ariaHidden: 'true' }), picture);
    // Cut out when that is on and works; otherwise the picture stays as it is.
    if (pictures === 'cutout') {
      cutout(src).then((cut) => {
        if (!cut) return;
        picture.src = cut;
        image.classList.add('card__image--cutout');
      });
    }
  } else {
    showPlaceholder();
  }

  const article = el(
    'article',
    { className: `card${selected.has(product.id) ? ' card--selected' : ''}`, draggable: true },
    el(
      'div',
      { className: 'card__media' },
      image,
      el(
        'div',
        { className: 'card__actions' },
        iconButton('Edit', ICONS.edit, () => editProduct(product), '', 'Change the title, price, lists, note or picture'),
        iconButton('Delete', ICONS.delete, () => confirmDelete(product), 'button--danger', 'Delete this item'),
      ),
      el('div', { className: 'card__corner' }, el('span', { className: 'card__grip', title: 'Drag to a list', innerHTML: ICONS.grip }), selectBox(product)),
      product.note && el('p', { className: 'card__note' }, el('span', { className: 'card__note-icon', innerHTML: ICONS.note }), el('span', { className: 'card__note-prefix', textContent: 'note: ' }), ...highlight(product.note)),
    ),
    cardMenu(product),
    el(
      'div',
      { className: 'card__body' },
      el('h3', { className: 'card__title', title: product.title }, el('a', link, ...highlight(product.title))),
      isBare(product) &&
        el('p', {
          className: 'card__pending',
          textContent: 'Details not read yet',
          title: 'ShopMarx on the computer reads the name, picture and price from the shop page once it may (Update prices, or Copy all pictures in Settings → Dropbox ⋯).',
        }),
      el(
        'div',
        { className: 'card__meta' },
        el(
          'p',
          { className: 'card__pricing' },
          el('span', { className: 'card__price', textContent: product.price != null ? formatPrice(product.price, product.currency, rates, state.currency) : 'N/A' }),
          change &&
            el('span', {
              className: change.percent < 0 ? 'card__change card__change--down' : 'card__change card__change--up',
              textContent: `${change.percent < 0 ? '▼' : '▲'} ${Math.abs(change.percent).toFixed(0)}%`,
              title: `Was ${formatPrice(change.from, product.currency, rates, state.currency)}`,
            }),
        ),
        el('p', { className: 'card__store' }, ...highlight(product.store)),
      ),
    ),
  );
  article.dataset.id = product.id;
  // Desktop: drag the card onto a list in the sidebar. Its links and picture are not
  // dragged on their own, so the drag always carries the whole card.
  for (const part of article.querySelectorAll('a, img')) part.draggable = false;
  article.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData(DRAG_TYPE, draggedIds(product).join());
    event.dataTransfer.effectAllowed = 'move';
    setDragGhost(event, article);
    article.classList.add('card--dragging');
    document.body.classList.add('dragging-card');
    markDropTargets(draggedIds(product));
  });
  article.addEventListener('dragend', () => {
    article.classList.remove('card--dragging');
    document.body.classList.remove('dragging-card');
    for (const link of document.querySelectorAll('.list-link--disabled')) link.classList.remove('list-link--disabled');
  });
  return article;
}

// List view: the hover buttons become one ⋯ menu at the end of the row.
function cardMenu(product) {
  const item = (label, icon, onclick, modifier = '', tip = label) =>
    el('button', { className: `menu__item ${modifier}`.trim(), type: 'button', role: 'menuitem', title: tip, innerHTML: `${icon}<span class="menu__label">${label}</span>`, onclick });
  const sheet = el(
    'div',
    { className: 'menu__sheet', role: 'menu', hidden: true },
    item('Edit', ICONS.edit, () => editProduct(product), '', 'Change the title, price, lists, note or picture'),
    item('Delete', ICONS.delete, () => confirmDelete(product), 'menu__item--danger', 'Delete this item'),
  );
  const toggle = el('button', { className: 'button button--ghost menu__toggle card__menu-toggle', type: 'button', title: 'Actions', ariaLabel: 'Actions', innerHTML: ICONS.more });
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  return el('div', { className: 'menu card__menu' }, toggle, sheet);
}

// Where each card is on screen, by item id.
function cardPositions() {
  return new Map([...$('grid').children].map((card) => [card.dataset.id, card.getBoundingClientRect()]));
}

// After a redraw: cards that stayed slide from their old place to the new one (FLIP),
// cards that are new fade in. A card that left is simply gone, and the rest close the gap.
function rearrange(before) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const card of $('grid').children) {
    const old = before.get(card.dataset.id);
    const now = card.getBoundingClientRect();
    if (!old) {
      card.animate([{ opacity: 0, transform: 'scale(0.95)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
    } else if (old.left !== now.left || old.top !== now.top) {
      card.animate([{ transform: `translate(${old.left - now.left}px, ${old.top - now.top}px)` }, { transform: 'none' }], {
        duration: 300,
        easing: 'ease-in-out',
      });
    }
  }
}

// A ticked card carries every ticked card with it; any other card goes alone.
function draggedIds(product) {
  return selected.has(product.id) ? [...selected] : [product.id];
}

function selectBox(product) {
  return el('input', {
    type: 'checkbox',
    className: 'card__select',
    checked: selected.has(product.id),
    title: 'Select',
    ariaLabel: `Select ${product.title}`,
    onchange: (event) => {
      if (event.target.checked) selected.add(product.id);
      else selected.delete(product.id);
      render();
    },
  });
}

// Lists a drop would not change are shown disabled while dragging: the list being viewed,
// and (from All Items or Unsorted) lists the item is already in, or Unsorted for an item
// in no list.
function markDropTargets(ids) {
  const products = state.products.filter((p) => ids.includes(p.id));
  const fromList = view.listId && view.listId !== UNSORTED;
  for (const link of document.querySelectorAll('#lists .list-link')) {
    const id = link.dataset.listId;
    // All Items (no id) is never a target. Others are unchanged only when the drop would
    // change none of the dragged items.
    const unchanged =
      !id || id === view.listId || products.every((p) => (id === UNSORTED ? !listsOf(p).length : !fromList && listsOf(p).includes(id)));
    link.classList.toggle('list-link--disabled', unchanged);
  }
}

// The picture that follows the pointer: the card at a quarter of its size, half see-through.
// Chrome takes a snapshot of the element at drag start, so it only needs to exist briefly
// (off screen).
function setDragGhost(event, article) {
  const SCALE = 0.25;
  const rect = article.getBoundingClientRect();
  const ghost = document.createElement('div');
  Object.assign(ghost.style, {
    position: 'fixed',
    top: '-10000px',
    left: '0',
    width: `${rect.width * SCALE}px`,
    height: `${rect.height * SCALE}px`,
    overflow: 'hidden',
    pointerEvents: 'none',
  });
  const copy = article.cloneNode(true);
  Object.assign(copy.style, { width: `${rect.width}px`, transform: `scale(${SCALE})`, transformOrigin: '0 0', opacity: '0.5' });
  ghost.append(copy);
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, (event.clientX - rect.left) * SCALE, (event.clientY - rect.top) * SCALE);
  setTimeout(() => ghost.remove());
}

// The same shop always gets the same colour.
function hueOf(text) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

function iconButton(label, icon, onclick, modifier = '', tip = label) {
  return el('button', { className: `button ${modifier}`.trim(), type: 'button', title: tip, ariaLabel: label, innerHTML: icon, onclick });
}

// Dialogs

// Cancel is a plain button, not a submit one: pressing Enter in a field submits with the
// form's first submit button, which is then Save rather than Cancel.
for (const cancel of document.querySelectorAll('.dialog [value="cancel"]')) {
  cancel.addEventListener('click', () => cancel.closest('dialog').close('cancel'));
}

function ask(dialog) {
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

// `list`: the list being renamed, which may keep its own name.
async function askName(title, value = '', list = null) {
  $('name-title').textContent = title;
  $('name-input').value = value;
  nameOwner = list;
  checkName();
  return (await ask($('name-dialog'))) ? $('name-input').value.trim() : null;
}

// Names are unique (store.js, listNamed): a taken one keeps the dialog open and says so.
let nameOwner = null;
function checkName() {
  const taken = listNamed(state.lists, $('name-input').value, nameOwner?.id);
  $('name-input').setCustomValidity(taken ? `There is already a list called “${taken.name}”.` : '');
}
$('name-input').addEventListener('input', checkName);

function confirmAction(title, text) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  // The usual single Delete button and no dropdown (removeListDialog may have set up more).
  Object.assign($('confirm-ok'), { textContent: 'Delete', title: 'Delete permanently', className: 'button button--danger-solid' });
  $('confirm-all').hidden = true;
  $('confirm-choice').hidden = true;
  return ask($('confirm-dialog'));
}

// Pictures for the edit dialog, stepped through with the pager as in the popup: the item's
// own picture first, then the ones on its shop page.
let editImages = [];
let editImageIndex = 0;

function showEditImage(index) {
  const count = editImages.length;
  editImageIndex = (index + count) % count || 0;
  $('edit-image').hidden = count === 0;
  // Hidden but still taking its room, so the picture column keeps the height of the fields.
  $('edit-pager').style.visibility = count < 2 ? 'hidden' : 'visible';
  if (count) $('edit-image').src = editImages[editImageIndex];
  $('edit-image-index').textContent = `${editImageIndex + 1} / ${count}`;
}

$('edit-prev-image').addEventListener('click', () => showEditImage(editImageIndex - 1));
$('edit-next-image').addEventListener('click', () => showEditImage(editImageIndex + 1));

// Reads the pictures from the item's shop page. Needs the shop's access, asked for like
// "Update prices" does; without it, or in the web app, there are none to find.
async function findPageImages(product) {
  if (!globalThis.chrome?.permissions) return [];
  // Must stay the first await: the permission prompt needs the click that got us here.
  const origins = [`${new URL(product.url).origin}/*`];
  const granted = await chrome.permissions.request({ origins }).catch(() => false);
  if (!granted) return [];
  try {
    const response = await fetch(product.url, { credentials: 'omit' });
    if (!response.ok) return [];
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    return globalThis.SaverExtract(doc, product.url, { fetched: true }).images;
  } catch {
    return [];
  }
}

async function editProduct(product) {
  $('edit-title').value = product.title;
  $('edit-price').value = product.price ?? '';
  $('edit-price-unit').textContent = product.currency ?? state.currency;
  $('edit-note').value = product.note;
  fillListChoice($('edit-lists'), state.lists, listsOf(product), NO_LIST_NAME);
  // Starts before the dialog opens: the permission prompt needs the click that got us here.
  const pageImages = findPageImages(product);
  editImages = [product.image].filter(Boolean);
  showEditImage(0);
  pageImages.then((found) => {
    if (!$('edit-dialog').open) return;
    const current = editImages[editImageIndex];
    editImages = [...new Set([...editImages, ...found])];
    showEditImage(Math.max(0, editImages.indexOf(current)));
  });
  if (!(await ask($('edit-dialog')))) return;
  await track(async () => {
    const listIds = await chosenLists($('edit-lists'));
    await updateProduct(product.id, {
    title: $('edit-title').value.trim(),
    image: editImages[editImageIndex] ?? null,
    price: globalThis.SaverExtract.parsePrice($('edit-price').value),
    listIds,
      note: $('edit-note').value.trim(),
    });
  });
}

async function confirmDelete(product) {
  if (await confirmAction('Delete this item?', product.title)) await track(() => removeProduct(product.id), 'Deleted.');
}

async function newList() {
  const name = await askName('Add new list');
  if (!name) return;
  const list = await track(() => createList(name));
  view.listId = list.id;
  refresh();
}

async function addSubList(parent) {
  const name = await askName(`Add new list in “${parent.name}”`);
  if (!name) return;
  setCollapsed(parent.id, false); // Open the parent so the new list shows.
  const list = await track(() => createList(name, parent.id));
  view.listId = list.id;
  refresh();
}

async function renameListDialog(list) {
  const name = await askName('Rename list', list.name, list);
  if (name) await track(() => renameList(list.id, name));
}

// A list with items offers two ways out: delete only the list, its items moving to where the
// dropdown says (Unsorted by default, or another list), or delete the list with all its items.
// "Unsorted" only takes them out of this list; items also in other lists stay there.
async function removeListDialog(list) {
  const title = `Remove the list “${list.name}”?`;
  const products = state.products.filter((p) => listsOf(p).includes(list.id));
  const count = products.length;
  if (!count) {
    if (await confirmAction(title, 'It has no items.')) await track(() => deleteList(list.id), `Removed the list “${list.name}”.`);
    return;
  }

  const items = `${count} ${count === 1 ? 'item' : 'items'}`;
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = `It has ${items}. Delete only the list and move them, or delete the list with them.`;
  const select = $('confirm-choice');
  select.replaceChildren(
    new Option(`Move items (${count}) to ${NO_LIST_NAME}`, UNSORTED, true, true),
    ...state.lists.filter((l) => l.id !== list.id).map((l) => new Option(`Move items (${count}) to “${listLabel(state.lists, l)}”`, l.id)),
  );
  select.hidden = false;
  Object.assign($('confirm-ok'), { textContent: 'Delete & move', title: 'Delete the list; move its items as chosen above', className: 'button button--danger-tint' });
  Object.assign($('confirm-all'), { textContent: `Delete with items (${count})`, title: 'Delete the list and every item in it', hidden: false });
  const dialog = $('confirm-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  const choice = await new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (choice !== 'ok' && choice !== 'all') return;

  const target = select.value;
  const targetName = state.lists.find((l) => l.id === target)?.name;
  animateGridUntil = Date.now() + 1000;
  const message = choice === 'all' ? `Deleted the list and ${items}.` : `Deleted the list; moved ${items} to ${targetName ? `“${targetName}”` : NO_LIST_NAME}.`;
  await track(async () => {
    for (const product of products) {
      if (choice === 'all') {
        await removeProduct(product.id);
        selected.delete(product.id);
      } else if (target !== UNSORTED) {
        await updateProduct(product.id, { listIds: [...new Set([...listsOf(product).filter((id) => id !== list.id), target])] });
      }
    }
    await deleteList(list.id);
  }, message);
}

function renameCurrentList() {
  return renameListDialog(state.lists.find((l) => l.id === view.listId));
}

function deleteCurrentList() {
  return removeListDialog(state.lists.find((l) => l.id === view.listId));
}

// Price checks

async function checkPrices() {
  const targets = visibleProducts();
  if (!targets.length) return toast('There is nothing here to check.');

  // Must stay the first await: the permission prompt needs the click that got us here.
  const origins = [...new Set(targets.map((product) => `${new URL(product.url).origin}/*`))];
  const granted = await chrome.permissions.request({ origins }).catch(() => false);
  if (!granted) return toast('ShopMarx needs access to those shops to read their prices.');

  const button = $('check-prices');
  button.disabled = true;
  button.querySelector('.menu__label').textContent = 'Updating prices';
  let changed = 0;
  let unreadable = 0;
  const spots = await priceSpots();
  const pending = [...targets];
  const worker = async () => {
    for (let product = pending.shift(); product; product = pending.shift()) {
      const price = await readCurrentPrice(product, spots);
      if (price == null) {
        unreadable += 1;
        continue;
      }
      if (price !== product.price) changed += 1;
      await updateProduct(product.id, { price, checkedAt: Date.now() });
    }
  };
  await Promise.all(Array.from({ length: PRICE_CHECKS_AT_ONCE }, worker));
  button.disabled = false;
  button.querySelector('.menu__label').textContent = 'Update prices';

  const parts = [`Checked ${targets.length}`, `${changed} changed`];
  if (unreadable) parts.push(`${unreadable} could not be read`);
  toast(`${parts.join(' · ')}.`);
}

async function readCurrentPrice(product, spots = {}) {
  try {
    const response = await fetch(product.url, { credentials: 'omit' });
    if (!response.ok) return null;
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const { price, currency } = globalThis.SaverExtract(doc, product.url, { priceSpot: spots[product.store] });
    // Without cookies a shop may answer in another currency; that is not a price change.
    if (currency && product.currency && currency !== product.currency) return null;
    return price;
  } catch {
    return null;
  }
}

// Export and import

async function exportToFile() {
  const blob = new Blob([JSON.stringify(await exportData(), null, 2)], { type: 'application/json' });
  const link = el('a', { href: URL.createObjectURL(blob), download: `saver-${new Date().toISOString().slice(0, 10)}.json` });
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importFromFile(event) {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  try {
    const added = await importData(JSON.parse(await file.text()));
    toast(`Imported ${added} ${added === 1 ? 'item' : 'items'}.`);
  } catch {
    toast('That file is not a ShopMarx export.');
  }
}

// Backup folder

// The backup and Dropbox rows in the settings menu: a status dot on the icon (off, on, warn,
// error, busy) and a line under the name saying what is going on.
function setStatus(prefix, state, text, tip) {
  $(`${prefix}-icon`).dataset.state = state;
  $(`${prefix}-sub`).textContent = text;
  $(`${prefix}-main`).title = tip;
}

// "just now", "5 min ago", "at 14:20" (today), "on 12 Oct" (earlier).
function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(time);
  if (date.toDateString() === new Date().toDateString()) return `at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return `on ${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}

async function refreshBackup() {
  backup = await backupStatus();
  const { state, name, savedAt } = backup;
  if (state === 'off') setStatus('backup', 'off', 'Off · click to choose a folder', 'Choose a folder to keep a JSON copy of everything');
  else if (state === 'paused') setStatus('backup', 'warn', `${name} · paused, click to allow again`, 'Allow ShopMarx to write to the folder again');
  else setStatus('backup', 'on', `${name} · ${savedAt ? `saved ${ago(savedAt)}` : 'not saved yet'}`, 'Save the backup now');
  $('backup-more').hidden = state === 'off';
}

// The row's own click does what is most likely wanted: choose a folder, allow it again, or save now.
function backupMain() {
  // No await before these: the folder picker and the permission prompt need this click.
  if (backup.state === 'off') return chooseBackupFolder();
  if (backup.state === 'paused') return resumeBackup();
  return backupNow();
}

async function backupNow() {
  setStatus('backup', 'busy', 'Saving…', 'Saving the backup');
  try {
    await writeBackup();
  } catch {
    toast('ShopMarx could not write to that folder.');
  }
  await refreshBackup();
}

async function chooseBackupFolder() {
  let existing;
  try {
    existing = await chooseFolder();
  } catch {
    return; // The picker was closed.
  }
  // A backup already in the folder is merged in first, so choosing a folder never loses what it holds.
  let added = 0;
  try {
    if (existing) added = await importData(existing);
  } catch {}
  try {
    await writeBackup();
  } catch {
    await refreshBackup();
    return toast('ShopMarx could not write to that folder.');
  }
  await refreshBackup();
  const restored = added ? ` ${added} ${added === 1 ? 'item' : 'items'} from the backup already there ${added === 1 ? 'was' : 'were'} added.` : '';
  toast(`Backing up to “${backup.name}” as ${BACKUP_FILE}.${restored}`);
}

async function resumeBackup() {
  // Must stay the first await: the permission prompt needs the click that got us here.
  const granted = (await backup.folder.requestPermission({ mode: 'readwrite' })) === 'granted';
  if (granted) await writeBackup().catch(() => {});
  await refreshBackup();
  toast(granted ? `Backing up to “${backup.name}” again.` : 'The backup is still paused.');
}

async function stopBackup() {
  await forgetFolder();
  await refreshBackup();
  toast(`Backup stopped. ${BACKUP_FILE} stays in the folder.`);
}

// Popup preview: the real popup page in a frame, loaded fresh on every open so it shows
// current styles and data. Its height follows the content.

// A click on the title while the preview is open first closes it (a click outside a popover
// closes it); without this guard the same click would open it again.
let previewClosedAt = 0;
$('popup-preview').addEventListener('toggle', (event) => {
  if (event.newState === 'closed') previewClosedAt = performance.now();
});

function togglePopupPreview() {
  const preview = $('popup-preview');
  if (performance.now() - previewClosedAt < 300) return;
  if (preview.matches(':popover-open')) return preview.hidePopover();
  const frame = $('popup-preview-frame');
  // Sized by the popup's body: the page's own scroll height never drops below the frame,
  // so it would only ever grow.
  frame.onload = () => {
    const body = frame.contentDocument.body;
    new ResizeObserver(() => (frame.style.height = `${body.offsetHeight}px`)).observe(body);
  };
  frame.src = 'popup.html?preview';
  preview.showPopover();
}

// Theme (applied on load by theme.js)

function currentTheme() {
  return document.documentElement.dataset.theme ?? (systemDark.matches ? 'dark' : 'light');
}

function toggleTheme() {
  const theme = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('theme', theme);
  } catch {}
  showThemeSwitch();
}

function showThemeSwitch() {
  const dark = currentTheme() === 'dark';
  $('theme-toggle').dataset.target = dark ? 'light' : 'dark';
  $('theme-toggle').querySelector('.menu__label').textContent = dark ? 'Light mode' : 'Dark mode';
}

// Add by link (the +): in the extension the page is read like the popup
// does; the web app cannot read other sites, so it saves the link and opens the item to
// fill in the rest.

async function addByLink() {
  $('add-url').value = '';
  const preselected = view.listId && view.listId !== UNSORTED ? [view.listId] : [];
  fillListChoice($('add-lists'), state.lists, preselected, NO_LIST_NAME);
  if (!(await ask($('add-dialog')))) return;
  let url;
  try {
    // Without tracking parameters, so the title fallback and the saved link are clean too.
    url = normalizeUrl(new URL($('add-url').value.trim()).href);
  } catch {
    return toast('That is not a link.');
  }
  const existing = findByUrl(state.products, url);
  if (existing) {
    toast('Already saved; here it is.');
    return editProduct(existing);
  }
  const page = (await addPermission) ? await readPage(url) : null;
  const product = await track(async () => saveProduct({
    url: page?.url ?? url,
    title: page?.title || url,
    image: page?.images[0] ?? null,
    price: page?.price ?? null,
    currency: page?.currency ?? state.currency,
    listIds: await chosenLists($('add-lists')),
  }));
  if (page?.title && page.price != null) toast('Added.');
  else editProduct(product);
}

async function readPage(url) {
  const spots = await priceSpots();
  return readShopPage(url, { priceSpot: spots[new URL(url).hostname.replace(/^www\./, '')], titleSpot: await titleSpotFor(url) });
}

// Dropbox sync

let dropboxBusy = false;

async function refreshDropbox() {
  const [status, key] = await Promise.all([dropboxStatus(), dropboxAppKey()]);
  const on = status.state === 'on';
  if (dropboxBusy) setStatus('dropbox', 'busy', 'Syncing…', 'Syncing with Dropbox');
  else if (!on) {
    setStatus('dropbox', 'off', key ? 'Not connected · click to connect' : 'Off · click to set up', 'Connect Dropbox to keep items in sync across devices');
  } else if (status.failed) setStatus('dropbox', 'error', 'Last sync failed · click to retry', 'Try syncing with Dropbox again');
  else setStatus('dropbox', 'on', `${status.name} · ${status.lastSync ? `synced ${ago(status.lastSync)}` : 'not synced yet'}`, 'Sync with Dropbox now');
  // The ⋯ once there is a setup; Sync now and Stop sync only while connected.
  $('dropbox-more').hidden = !on && !key;
  $('dropbox-sync').hidden = !on;
  $('dropbox-disconnect').hidden = !on;
  $('dropbox-shortcut').hidden = !on;
  $('dropbox-pictures').hidden = !on || WEB || (await chrome.permissions.contains({ origins: ALL_SITES }));
}

async function showShortcutSetup() {
  const setup = await shortcutSetup();
  if (!setup) return;
  $('shortcut-key').value = setup.appKey;
  $('shortcut-token').value = setup.token;
  await ask($('shortcut-dialog'));
}

// Picture copies are made from shops the extension has access to (and shops that allow it);
// granting all of them once lets it copy every picture.
const ALL_SITES = ['http://*/*', 'https://*/*'];

async function allowAllPictures() {
  // Must stay the first await: the permission prompt needs the click that got us here.
  const granted = await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false);
  if (!granted) return toast('Pictures are copied only from shops ShopMarx already has access to.');
  await retryFailedThumbs();
  await refreshDropbox();
  toast('Copying the pictures to Dropbox. They appear as they are saved.');
  afterSync();
}

// The row's own click: sync now when connected, otherwise connect (setting up first if needed).
async function dropboxMain() {
  if ((await dropboxStatus()).state === 'on') runSync(true);
  else connectToDropbox();
}

async function runSync(announce) {
  dropboxBusy = true;
  await refreshDropbox();
  try {
    const synced = await syncNow();
    if (synced && announce) toast('Synced with Dropbox.');
    // Can take a while; the cards update as details and picture copies arrive.
    if (synced) afterSync();
  } catch (error) {
    console.error(error);
    if (announce) toast('Dropbox sync failed. Check the connection and try again.');
  } finally {
    dropboxBusy = false;
  }
  await refreshDropbox();
}

// Asks for the app key the first time; `again` shows the setup steps once more, with the
// saved key filled in (after a sign-in that did not finish).
async function askDropboxAppKey(again = false) {
  const saved = await dropboxAppKey();
  if (saved && !again) return true;
  $('dropbox-key-input').value = saved;
  try {
    $('dropbox-redirect').textContent = dropboxRedirectUri();
  } catch {
    $('dropbox-redirect').textContent = 'shown when this runs as the extension'; // e.g. the localhost preview
  }
  if (!(await ask($('dropbox-key-dialog')))) return false;
  const key = $('dropbox-key-input').value.trim();
  if (!key) return false;
  await saveDropboxAppKey(key);
  refreshDropbox(); // Shows the × that clears it.
  return true;
}

async function connectToDropbox(again = false) {
  if (!(await askDropboxAppKey(again))) return;
  try {
    await connectDropbox(); // The web app leaves the page here and comes back connected.
    toast('Connected to Dropbox.');
    await runSync(true);
  } catch (error) {
    console.error(error);
    // Usually a setup step is missing (the redirect URI, public clients) or the key is wrong:
    // show the steps again so it can be fixed and retried.
    toast('Dropbox sign-in did not finish. Check the steps and try again.');
    connectToDropbox(true);
  }
}

async function clearDropboxSetup() {
  await resetDropbox();
  await refreshDropbox();
  toast('Dropbox setup cleared. Sync with Dropbox starts over.');
}

async function disconnectFromDropbox() {
  await disconnectDropbox();
  await refreshDropbox();
  toast('Dropbox sync stopped. shopmarks.json stays in your Dropbox.');
}

// `action` adds a button to the toast (Undo) that runs `run`.
function toast(text, { action, run } = {}) {
  const box = $('toast');
  box.replaceChildren(text);
  if (action) {
    const button = el('button', { className: 'toast__action', type: 'button', textContent: action });
    button.addEventListener('click', () => {
      box.hidePopover();
      run();
    });
    box.append(button);
  }
  // Shown again so it is the newest in the top layer, above a dialog opened since.
  box.hidePopover();
  box.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.hidePopover(), action ? UNDO_MS : TOAST_MS);
}
