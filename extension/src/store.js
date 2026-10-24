// All persistence goes through this module. Records carry ids and timestamps
// so a sync backend can replace chrome.storage later without touching the UI.

// An item can be in several lists (listIds); with none it is unsorted and shows under All
// Items only. Items saved before that carry a single listId, where this id meant no list.
export const DEFAULT_LIST_ID = 'default';
export const NO_LIST_NAME = 'Unsorted';
// The currency prices are shown in, chosen in the dashboard's settings menu.
export const DEFAULT_CURRENCY = 'EUR';
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CZK', 'PLN', 'HUF', 'SEK', 'DKK', 'NOK'];

// Query parameters that only track where a visit came from, dropped from saved links (see
// normalizeUrl). Ad networks and analytics (Google, Meta, TikTok, Microsoft, Yandex,
// HubSpot, Mailchimp, Seznam/Sklik), AliExpress's spm / scm / algo_* / aff_*, and Amazon's
// ref / pd_rd_* / pf_rd_* / search leftovers. Parameters that pick the product (ids,
// variants, sellers) are kept.
const TRACKING_PARAM = new RegExp(
  '^(' +
    [
      'utm_\\w+', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'igshid', 'ttclid', 'twclid', 'msclkid',
      'yclid', 'li_fat_id', 'mc_[ce]id', '_ga', '_gl', '_hs\\w+', '__hs\\w+', 'hsCtaTracking', 'srsltid', 'sznclid',
      'spm', 'scm', 'pvid', 'utparam(-\\w+)?', 'algo_\\w+', 'aff_\\w+', 'afSmartRedirect', 'businessCode', 'gatewayAdapt',
      'terminal_id', '_randl_\\w+', 'pdp_\\w+', 'sk',
      'ref_?', 'pd_rd_\\w+', 'pf_rd_\\w+', 'content-id', 'linkCode', 'linkId', 'ascsubtag', 'qid', 'sr', 'crid', 'sprefix', 'keywords', 'dib', 'dib_tag',
    ].join('|') +
    ')$',
  'i',
);
const EDITABLE_FIELDS = ['title', 'image', 'listIds', 'note'];
const LOCALE = 'sk-SK';
const RATES_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR';
const RATES_MAX_AGE = 12 * 60 * 60 * 1000;

export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    // Amazon puts its tracking in the path too: /dp/B0…/ref=sr_1_3.
    parsed.pathname = parsed.pathname.replace(/\/ref=[^/]*$/, '');
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.href;
  } catch {
    return url;
  }
}

export function storeOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Compares cleaned links, so an item saved before a tracking parameter was known still matches.
export function findByUrl(products, url) {
  const normalized = normalizeUrl(url);
  return products.find((product) => normalizeUrl(product.url) === normalized);
}

// Euro exchange rates from the ECB (via Frankfurter): how much of each currency one euro buys.
// Kept for half a day; an older copy is used while the service can't be reached.
export async function loadRates() {
  const { rates: cached } = await chrome.storage.local.get('rates');
  if (cached && Date.now() - cached.fetchedAt < RATES_MAX_AGE) return cached.values;
  try {
    const response = await fetch(RATES_URL);
    if (!response.ok) throw new Error(`Rates: ${response.status}`);
    const { rates } = await response.json();
    await chrome.storage.local.set({ rates: { values: rates, fetchedAt: Date.now() } });
    return rates;
  } catch {
    return cached?.values ?? {};
  }
}

// The price in euros, or null when its currency has no known rate. A price without a currency counts as euros.
export function toEuro(price, currency, rates = {}) {
  if (price == null) return null;
  if (!currency || currency === 'EUR') return price;
  return rates[currency] ? price / rates[currency] : null;
}

// Prices are shown in the chosen currency the Slovak way ("17,30 €"); a converted one starts
// with "≈". Without a rate for either currency, a price stays in its own currency.
export function formatPrice(price, currency, rates = {}, display = DEFAULT_CURRENCY) {
  if (price == null) return '';
  const from = currency || display;
  const euros = toEuro(price, from, rates);
  const shown = euros == null ? null : display === 'EUR' ? euros : rates[display] ? euros * rates[display] : null;
  try {
    if (shown == null) return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: from }).format(price);
    return `${from !== display ? '≈ ' : ''}${new Intl.NumberFormat(LOCALE, { style: 'currency', currency: display }).format(shown)}`;
  } catch {
    return `${price} ${from}`;
  }
}

// How the current price compares with the price when the product was saved.
export function priceChange(product) {
  const first = product.priceHistory?.[0]?.price;
  if (first == null || product.price == null || first === product.price) return null;
  return { from: first, percent: ((product.price - first) / first) * 100 };
}

// The lists a product is in, for old single-list records too.
export function listsOf(product) {
  if (Array.isArray(product.listIds)) return product.listIds;
  return product.listId && product.listId !== DEFAULT_LIST_ID ? [product.listId] : [];
}

export async function getState() {
  const keys = ['products', 'lists', 'currency', 'lastListIds'];
  const { products = [], lists = [], currency = DEFAULT_CURRENCY, lastListIds = [] } = await chrome.storage.local.get(keys);
  // The lists the popup saved into last time; deleted ones drop out.
  const lastUsed = lastListIds.filter((id) => lists.some((list) => list.id === id));
  return { products, lists, currency, lastListIds: lastUsed };
}

// Where each shop shows its price, as pointed out by the user with the popup's picker:
// { [shop]: { selector, label } } (see picker.js). Used when reading a product page and
// when checking prices.
export async function priceSpots() {
  const { priceSpots: spots = {} } = await chrome.storage.local.get('priceSpots');
  return spots;
}

export async function priceSpotFor(url) {
  return (await priceSpots())[storeOf(url)] ?? null;
}

export async function setPriceSpot(url, spot) {
  const spots = await priceSpots();
  await chrome.storage.local.set({ priceSpots: { ...spots, [storeOf(url)]: spot } });
}

// { [shop]: { selector } }: where the shop shows the product name, picked like the price spot.
export async function titleSpotFor(url) {
  const { titleSpots: spots = {} } = await chrome.storage.local.get('titleSpots');
  return spots[storeOf(url)] ?? null;
}

export async function setTitleSpot(url, spot) {
  const { titleSpots: spots = {} } = await chrome.storage.local.get('titleSpots');
  await chrome.storage.local.set({ titleSpots: { ...spots, [storeOf(url)]: spot } });
}

// An item that is still only its link (shared from the iPhone, or added with + in the web
// app): no name, picture or price read from the shop yet. See fill.js.
export const isBare = (product) => product.title === product.url && !product.image && product.price == null;

// Visited is never one of them: it is filled in the background only.
export function rememberLists(listIds) {
  return chrome.storage.local.set({ lastListIds: listIds.filter((id) => id !== VISITED_LIST_ID) });
}

export function setCurrency(currency) {
  return chrome.storage.local.set({ currency });
}

export function onChange(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    // Fresh exchange rates are not a change to the saved data.
    if (area === 'local' && !('rates' in changes)) callback();
  });
}

let queue = Promise.resolve();

// Every write is read-modify-write on the same keys, so writes from one page
// run one at a time; otherwise parallel price checks would overwrite each other.
function mutate(change) {
  const run = queue.then(async () => {
    const data = { products: [], lists: [], deleted: {}, ...(await chrome.storage.local.get(['products', 'lists', 'deleted'])) };
    data.deleted = { products: {}, lists: {}, ...data.deleted };
    // Old single-list records move to listIds on the first write.
    for (const product of data.products) {
      if ('listId' in product) {
        product.listIds = listsOf(product);
        delete product.listId;
      }
      // Links saved with tracking parameters are cleaned on the first write (with a title that
      // was only the link); a newer updatedAt carries the clean link to other devices.
      const clean = normalizeUrl(product.url);
      if (clean !== product.url) {
        if (product.title === product.url) product.title = clean;
        product.url = clean;
        product.updatedAt = Date.now();
      }
    }
    const result = change(data);
    await chrome.storage.local.set(data);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

function setPrice(product, price, currency, at) {
  product.price = price ?? null;
  if (currency !== undefined) product.currency = currency;
  if (price != null && product.priceHistory.at(-1)?.price !== price) {
    product.priceHistory.push({ price, at });
  }
}

function applyPatch(product, patch, at) {
  const { price, currency, ...rest } = patch;
  Object.assign(product, rest, { updatedAt: at });
  if (price !== undefined) setPrice(product, price, currency, at);
}

// Saves a new product, or updates the one already saved under the same URL.
export function saveProduct(draft) {
  const url = normalizeUrl(draft.url);
  const now = Date.now();
  return mutate(({ products }) => {
    let product = products.find((p) => p.url === url);
    if (!product) {
      product = {
        id: crypto.randomUUID(),
        url,
        store: storeOf(url),
        title: url,
        image: null,
        price: null,
        currency: null,
        listIds: [],
        note: '',
        priceHistory: [],
        createdAt: now,
      };
      products.unshift(product);
    }
    const patch = { price: draft.price, currency: draft.currency };
    for (const field of EDITABLE_FIELDS) {
      if (draft[field] !== undefined) patch[field] = draft[field];
    }
    applyPatch(product, patch, now);
    return product;
  });
}

export function updateProduct(id, patch) {
  return mutate(({ products }) => {
    const product = products.find((p) => p.id === id);
    if (product) applyPatch(product, patch, Date.now());
    return product ?? null;
  });
}

// Deletions leave a marker (id → time) so syncing does not bring the item back from
// another device that still has it.
export function removeProduct(id) {
  return mutate((data) => {
    data.products = data.products.filter((p) => p.id !== id);
    data.deleted.products[id] = Date.now();
  });
}

// Undo and redo: puts these records (items and lists, as they were at some point) back,
// counted as changed now so syncing keeps them, and drops their deletion markers. `remove`
// holds the ids of records to delete, as removeProduct and deleteList do (records an undone
// step had made).
export function restoreRecords({ products = [], lists = [] }, remove = { products: [], lists: [] }) {
  return mutate((data) => {
    const now = Date.now();
    for (const key of ['products', 'lists']) {
      const ids = new Set(remove[key] ?? []);
      if (!ids.size) continue;
      data[key] = data[key].filter((record) => !ids.has(record.id));
      for (const id of ids) data.deleted[key][id] = now;
    }
    const put = (key, records, gone) => {
      for (const record of records) {
        data[key] = data[key].filter((held) => held.id !== record.id);
        data[key].push({ ...structuredClone(record), updatedAt: now });
        delete gone[record.id];
      }
    };
    put('products', products, data.deleted.products);
    put('lists', lists, data.deleted.lists);
    data.products.sort(byNewest);
    data.lists.sort(byListOrder);
  });
}

// List names are unique, ignoring case, so a typed name always means one list. The list
// called `name`, other than the one with id `exceptId` (a list being renamed); undefined if none.
export function listNamed(lists, name, exceptId = null) {
  const lower = name.trim().toLowerCase();
  return lists.find((list) => list.id !== exceptId && list.name.toLowerCase() === lower);
}

// A name that only some lists share (made before names were unique) gets the parent's name
// added where lists are picked: "Ideas (in Home)".
export function listLabel(lists, list) {
  if (list.shop) return `${list.name} (${list.shop})`;
  if (lists.filter((other) => other.name.toLowerCase() === list.name.toLowerCase()).length < 2) return list.name;
  const parent = lists.find((other) => other.id === list.parentId);
  return parent ? `${list.name} (in ${parent.name})` : `${list.name} (top level)`;
}

// parentId: the list this one goes under (a sub-list); none for a top-level list. A name
// already taken gives back that list instead of a second one with the same name.
// shop: a list that belongs to a shop (an item's store, see storeOf), shown under that shop in
// the dashboard's Shops instead of among the other lists; its sub-lists carry the shop too.
export function createList(name, parentId = null, shop = null) {
  return mutate(({ lists }) => {
    const taken = listNamed(lists, name);
    if (taken) return taken;
    const now = Date.now();
    const created = { id: crypto.randomUUID(), name: name.trim(), createdAt: now, updatedAt: now };
    if (parentId) created.parentId = parentId;
    if (shop) created.shop = shop;
    lists.push(created);
    return created;
  });
}

// Lists form a tree through parentId. In tree order, each list followed by its sub-lists
// (siblings keep the list order), with its depth; a missing parent, or a loop, makes a list
// top-level. Sub-lists of a list in `collapsed` are left out.
export function listTree(lists, collapsed = new Set()) {
  const ids = new Set(lists.map((l) => l.id));
  const parentOf = (list) => (list.parentId && ids.has(list.parentId) && list.parentId !== list.id ? list.parentId : null);
  const children = new Map();
  for (const list of lists) {
    const parent = parentOf(list);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(list);
  }
  const rows = [];
  const seen = new Set();
  // Every list is visited (so `seen` is complete); only those under open lists become rows.
  const walk = (parent, depth, shown) => {
    for (const list of children.get(parent) ?? []) {
      if (seen.has(list.id)) continue;
      seen.add(list.id);
      const hasChildren = (children.get(list.id) ?? []).length > 0;
      if (shown) rows.push({ list, depth, hasChildren });
      walk(list.id, depth + 1, shown && !collapsed.has(list.id));
    }
  };
  walk(null, 0, true);
  // A loop (a under b under a) is never reached from the top: show those lists at the top.
  for (const list of lists) if (!seen.has(list.id)) rows.push({ list, depth: 0, hasChildren: false });
  return rows;
}

// A list's id with the ids of all its sub-lists, at any depth.
export function branchOf(lists, id) {
  const branch = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const list of lists) {
      if (list.parentId && branch.has(list.parentId) && !branch.has(list.id)) {
        branch.add(list.id);
        grew = true;
      }
    }
  }
  return branch;
}

// The user's order (dragged in the sidebar): every list gets its place as `position`, and
// counts as changed so the order syncs like any other edit.
// moved / parentId: the dragged list also takes the level of the list it was dropped next to.
export function reorderLists(ids, moved = null, parentId = null) {
  return mutate((data) => {
    const now = Date.now();
    for (const list of data.lists) {
      const position = ids.indexOf(list.id);
      if (position !== -1 && list.position !== position) Object.assign(list, { position, updatedAt: now });
      if (list.id === moved && (list.parentId ?? null) !== parentId) Object.assign(list, { parentId, updatedAt: now });
    }
    data.lists.sort(byListOrder);
  });
}

// A name another list has is refused (the dialog says so before it gets here).
export function renameList(id, name) {
  return mutate(({ lists }) => {
    if (listNamed(lists, name, id)) return;
    const target = lists.find((l) => l.id === id);
    if (target) Object.assign(target, { name: name.trim(), updatedAt: Date.now() });
  });
}

// Products in a deleted list are kept, in their other lists or unsorted. Its sub-lists move
// up one level, under its own parent.
export function deleteList(id) {
  return mutate((data) => {
    const now = Date.now();
    const gone = data.lists.find((l) => l.id === id);
    for (const list of data.lists) {
      if (list.parentId === id) Object.assign(list, { parentId: gone?.parentId ?? null, updatedAt: now });
    }
    data.lists = data.lists.filter((l) => l.id !== id);
    data.deleted.lists[id] = now;
    for (const product of data.products) {
      if (!product.listIds.includes(id)) continue;
      product.listIds = product.listIds.filter((listId) => listId !== id);
      product.updatedAt = now;
    }
  });
}

// Older versions kept shops as lists: a top-level list "Shops" with one list per shop under
// it ("ikea.com", or cut short as "ikea."), the items saved into them. Now every shop has its
// own row, so those lists go: the lists made inside a shop's list become that shop's lists,
// items only in a shop's list (or in "Shops") just leave it, and "Shops" and the shop lists
// are deleted. Returns whether anything changed.
const isOldShops = (list) => !list.parentId && !list.shop && list.name.trim().toLowerCase() === 'shops';

// Cheap to ask on every redraw: migrateShopLists writes, which starts another redraw.
export function hasOldShopLists(lists) {
  return lists.some(isOldShops);
}

export function migrateShopLists() {
  return mutate((data) => {
    const top = data.lists.filter(isOldShops);
    if (!top.length) return false;
    const now = Date.now();
    const stores = [...new Set(data.products.map((product) => product.store).filter(Boolean))];
    const shopFor = (name) => {
      const short = name.trim().toLowerCase().replace(/\.+$/, '');
      return stores.find((store) => store === short) ?? stores.find((store) => store.startsWith(`${short}.`)) ?? short;
    };
    const gone = new Set(top.map((list) => list.id));
    const shopLists = data.lists.filter((list) => gone.has(list.parentId));
    for (const shopList of shopLists) {
      const shop = shopFor(shopList.name);
      gone.add(shopList.id);
      for (const id of branchOf(data.lists, shopList.id)) {
        const list = data.lists.find((l) => l.id === id);
        if (id === shopList.id || !list) continue;
        Object.assign(list, { shop, updatedAt: now });
        if (list.parentId === shopList.id) list.parentId = null;
      }
    }
    for (const product of data.products) {
      const kept = listsOf(product).filter((id) => !gone.has(id));
      if (kept.length === listsOf(product).length) continue;
      Object.assign(product, { listIds: kept, updatedAt: now });
    }
    data.lists = data.lists.filter((list) => !gone.has(list.id));
    for (const id of gone) data.deleted.lists[id] = now;
    return true;
  });
}

// Product pages visited in Chrome, remembered when the user turned that on (the dashboard's
// settings, visitDays): they go into the Visited list, which has a fixed id so every device
// shares one. A visited item that is only in Visited is forgotten visitDays after the last
// visit; put into another list (or out of Visited) it is the user's and stays.
export const VISITED_LIST_ID = 'visited';

export async function visitDays() {
  const { visitDays: days = 0 } = await chrome.storage.local.get('visitDays');
  return days;
}

export function setVisitDays(days) {
  return chrome.storage.local.set({ visitDays: days });
}

const onlyVisited = (product) => listsOf(product).length === 1 && listsOf(product)[0] === VISITED_LIST_ID;

// draft: what the extractor read on the page. A product already saved keeps its lists and
// only gets the current price; a new one goes into Visited.
export function rememberVisit(draft) {
  const url = normalizeUrl(draft.url);
  const now = Date.now();
  return mutate(({ products, lists }) => {
    if (!lists.some((list) => list.id === VISITED_LIST_ID)) {
      lists.push({ id: VISITED_LIST_ID, name: 'Visited', visited: true, createdAt: now, updatedAt: now });
    }
    let product = products.find((p) => p.url === url);
    if (product) {
      // A page that shows no price this time keeps the price known before.
      const patch = draft.price != null ? { price: draft.price, currency: draft.currency ?? product.currency } : {};
      if (onlyVisited(product)) Object.assign(patch, { visitedAt: now, title: draft.title || product.title, image: draft.images?.[0] ?? product.image });
      applyPatch(product, patch, now);
      return product;
    }
    product = {
      id: crypto.randomUUID(),
      url,
      store: storeOf(url),
      title: draft.title || url,
      image: draft.images?.[0] ?? null,
      price: null,
      currency: null,
      listIds: [VISITED_LIST_ID],
      note: '',
      priceHistory: [],
      createdAt: now,
      visitedAt: now,
    };
    products.unshift(product);
    applyPatch(product, { price: draft.price, currency: draft.currency }, now);
    return product;
  });
}

// Forgets the visited items not visited for `days`; writes only when there is one.
export async function forgetOldVisits(days) {
  if (!days) return 0;
  const before = Date.now() - days * 24 * 60 * 60 * 1000;
  const old = (product) => onlyVisited(product) && (product.visitedAt ?? product.createdAt) < before;
  const { products = [] } = await chrome.storage.local.get('products');
  if (!products.some(old)) return 0;
  return mutate((data) => {
    const gone = data.products.filter(old);
    data.products = data.products.filter((product) => !old(product));
    for (const product of gone) data.deleted.products[product.id] = Date.now();
    return gone.length;
  });
}

export async function exportData() {
  const { products = [], lists = [] } = await chrome.storage.local.get(['products', 'lists']);
  return { app: 'saver', version: 1, exportedAt: new Date().toISOString(), lists, products };
}

// Merges an export into what is already saved and returns how many products
// were added. The file comes from disk, so every field is checked.
export function importData(data) {
  if (!Array.isArray(data?.products)) throw new Error('Not a Saver export');
  const now = Date.now();
  return mutate(({ products, lists }) => {
    const listIds = new Set(lists.map((l) => l.id));
    for (const incoming of Array.isArray(data.lists) ? data.lists : []) {
      if (typeof incoming?.id !== 'string' || typeof incoming.name !== 'string' || listIds.has(incoming.id)) continue;
      const list = { id: incoming.id, name: incoming.name, createdAt: Number(incoming.createdAt) || now };
      if (typeof incoming.parentId === 'string') list.parentId = incoming.parentId;
      lists.push(list);
      listIds.add(incoming.id);
    }

    const urls = new Set(products.map((p) => p.url));
    const httpUrl = (value) => (typeof value === 'string' && /^https?:\/\//.test(value) ? value : null);
    let added = 0;
    for (const incoming of data.products) {
      const url = httpUrl(incoming?.url);
      if (!url || urls.has(url)) continue;
      const history = Array.isArray(incoming.priceHistory) ? incoming.priceHistory : [];
      products.push({
        id: crypto.randomUUID(),
        url,
        store: storeOf(url),
        title: String(incoming.title ?? url),
        image: httpUrl(incoming.image),
        price: Number.isFinite(incoming.price) ? incoming.price : null,
        currency: typeof incoming.currency === 'string' ? incoming.currency : null,
        listIds: listsOf(incoming).filter((id) => listIds.has(id)),
        note: String(incoming.note ?? ''),
        priceHistory: history.filter((entry) => Number.isFinite(entry?.price) && Number.isFinite(entry?.at)),
        createdAt: Number(incoming.createdAt) || now,
        updatedAt: now,
      });
      urls.add(url);
      added += 1;
    }
    return added;
  });
}

// Syncing (see sync.js). Every device keeps the whole collection; a sync merges the
// copy in the cloud with this one record by record: the more recently changed record
// wins, and a deletion wins over any change made before it.

const changedAt = (record) => record.updatedAt ?? record.createdAt ?? 0;

function mergeRecords(a = [], b = [], gone = {}) {
  const byId = new Map();
  for (const record of [...a, ...b]) {
    const held = byId.get(record.id);
    if (!held || changedAt(record) > changedAt(held)) byId.set(record.id, record);
  }
  return [...byId.values()].filter((record) => !(gone[record.id] >= changedAt(record)));
}

function mergeMarkers(a = {}, b = {}) {
  const merged = { ...a };
  for (const [id, at] of Object.entries(b)) merged[id] = Math.max(merged[id] ?? 0, at);
  return merged;
}

// The same order on every device, so equal data serialises identically.
const byNewest = (x, y) => y.createdAt - x.createdAt || (x.id < y.id ? -1 : 1);
// Lists: in the order the user dragged them into; lists never moved (no position) come after,
// oldest first (a position is a small number, a creation time a large one).
const byListOrder = (x, y) => (x.position ?? x.createdAt) - (y.position ?? y.createdAt) || x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1);

// The same product saved on two devices before they synced becomes one item: the one saved
// first keeps its id, takes the most recent details, every list either copy was in and both
// price histories; the other copy is marked deleted. The same on every device, so all agree.
function mergeDuplicates(products, deleted) {
  const groups = new Map();
  for (const product of products) {
    const key = normalizeUrl(product.url);
    groups.set(key, [...(groups.get(key) ?? []), product]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const [first, ...rest] = [...group].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
    const latest = group.reduce((held, next) => (changedAt(next) > changedAt(held) ? next : held));
    const at = Math.max(...group.map(changedAt));
    for (const other of rest) deleted.products[other.id] = Math.max(deleted.products[other.id] ?? 0, at);
    const history = new Map(group.flatMap((product) => product.priceHistory ?? []).map((entry) => [`${entry.at}:${entry.price}`, entry]));
    return {
      ...latest,
      id: first.id,
      createdAt: first.createdAt,
      listIds: [...new Set(group.flatMap(listsOf))],
      priceHistory: [...history.values()].sort((x, y) => x.at - y.at),
      // Newer than every copy, so this merged one wins on each device.
      updatedAt: at + 1,
    };
  });
}

export function mergeData(a = {}, b = {}) {
  const deleted = {
    products: mergeMarkers(a.deleted?.products, b.deleted?.products),
    lists: mergeMarkers(a.deleted?.lists, b.deleted?.lists),
  };
  const records = mergeRecords(a.products, b.products, deleted.products).map((product) => {
    const listIds = listsOf(product);
    const { listId, ...rest } = product;
    return { ...rest, listIds };
  });
  const products = mergeDuplicates(records, deleted);
  return {
    lists: mergeRecords(a.lists, b.lists, deleted.lists).sort(byListOrder),
    products: products.sort(byNewest),
    deleted,
  };
}

export async function syncData() {
  const { products = [], lists = [], deleted = {} } = await chrome.storage.local.get(['products', 'lists', 'deleted']);
  return { products, lists, deleted: { products: {}, lists: {}, ...deleted } };
}

export const sameData = (a, b) =>
  JSON.stringify([a.products, a.lists, a.deleted]) === JSON.stringify([b.products, b.lists, b.deleted]);

// Replaces this device's collection with a merged one. Writes only on a real change:
// every write starts another sync, which then finds nothing to do.
export async function applySyncData(merged) {
  if (sameData(await syncData(), merged)) return false;
  await mutate((data) => Object.assign(data, merged));
  return true;
}
