// Keeps the collection in one file in Dropbox (Apps/<app>/shopmarks.json), shared by every
// device: the extension on a computer and the web app (PWA) on a phone. Each sync reads
// the file, merges it with this device's copy record by record (store.js, mergeData),
// saves the result here and, if it differs, writes it back. Dropbox refuses the write when
// someone else changed the file in between; then the sync starts over.
//
// Sign-in is Dropbox OAuth with PKCE (no server or secret): in the extension through
// chrome.identity, in the web app by sending the page to Dropbox and back.

import { applySyncData, findByUrl, getState, mergeData, normalizeUrl, sameData, saveProduct, syncData } from './store.js';

const FILE = '/shopmarks.json';
// Links shared from an iPhone by the Save to ShopMarks shortcut (SHORTCUT.md): one text file
// each, taken in as new items on the next sync.
const INBOX = '/inbox';
const KEY = 'dropbox';
const APP_KEY = 'dropboxAppKey';
const LOCK = 'shopmarks-sync';
const SYNC_DELAY = 2000;
const VERIFIER = 'shopmarks-dropbox-verifier';
const WEB = Boolean(globalThis.shopMarksWeb);

let accessToken = null;
let accessTokenExpires = 0;

// The Dropbox app key (App Console → your app → App key) is asked for in the dashboard and
// kept on this device. It is public (PKCE), so storing it is fine. Setup: DROPBOX.md.
export async function dropboxAppKey() {
  const { [APP_KEY]: key } = await chrome.storage.local.get(APP_KEY);
  return key ?? '';
}

export async function saveDropboxAppKey(key) {
  await chrome.storage.local.set({ [APP_KEY]: key.trim() });
}

// state is 'off' (not connected) or 'on'; lastSync is a timestamp; failed is true when the
// latest sync attempt failed (it clears on the next one that works).
export async function dropboxStatus() {
  const { [KEY]: account } = await chrome.storage.local.get(KEY);
  if (!account) return { state: 'off' };
  return { state: 'on', name: account.name, lastSync: account.lastSync, failed: (account.failedAt ?? 0) > (account.lastSync ?? 0) };
}

// Where Dropbox sends the user back after sign-in; it must be listed in the Dropbox app.
export function redirectUri() {
  return WEB ? `${location.origin}${location.pathname}` : chrome.identity.getRedirectURL('dropbox');
}

function authorizeUrl(appKey, challenge) {
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    redirect_uri: redirectUri(),
  });
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

// Extension: resolves once connected. Web app: leaves for Dropbox; the page comes back
// with a code that finishDropboxRedirect() turns into the connection.
export async function connectDropbox() {
  const appKey = await dropboxAppKey();
  if (!appKey) throw new Error('No Dropbox app key yet');
  const verifier = randomString();
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  if (WEB) {
    sessionStorage.setItem(VERIFIER, verifier);
    location.assign(authorizeUrl(appKey, challenge));
    return new Promise(() => {}); // The page is leaving.
  }
  const returned = await chrome.identity.launchWebAuthFlow({ url: authorizeUrl(appKey, challenge), interactive: true });
  await finishConnect(new URL(returned).searchParams.get('code'), verifier);
}

// Web app: call on load. True when the page just came back from Dropbox and is connected.
export async function finishDropboxRedirect() {
  if (!WEB) return false;
  const code = new URLSearchParams(location.search).get('code');
  const verifier = sessionStorage.getItem(VERIFIER);
  if (!code || !verifier) return false;
  sessionStorage.removeItem(VERIFIER);
  history.replaceState(null, '', location.pathname);
  await finishConnect(code, verifier);
  return true;
}

async function finishConnect(code, verifier) {
  if (!code) throw new Error('Dropbox sign-in was cancelled');
  const token = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri() });
  rememberAccess(token);
  const account = await api('https://api.dropboxapi.com/2/users/get_current_account', { body: 'null', json: true });
  await chrome.storage.local.set({ [KEY]: { refreshToken: token.refresh_token, name: account.name?.display_name ?? 'Dropbox' } });
}

// What the iPhone shortcut needs to write to the inbox; null when not connected.
export async function shortcutSetup() {
  const { [KEY]: account } = await chrome.storage.local.get(KEY);
  return account ? { appKey: await dropboxAppKey(), token: account.refreshToken } : null;
}

export async function disconnectDropbox() {
  accessToken = null;
  await chrome.storage.local.remove(KEY);
}

// Back to the first-time state: no app key, no sign-in, no half-finished sign-in. The file
// in Dropbox is not touched.
export async function resetDropbox() {
  accessToken = null;
  accessTokenExpires = 0;
  await chrome.storage.local.remove([KEY, APP_KEY]);
  try {
    sessionStorage.removeItem(VERIFIER);
  } catch {}
}

// Merges this device with the file in Dropbox. Returns false when not connected.
export function syncNow() {
  return navigator.locks.request(LOCK, async () => {
    const status = await dropboxStatus();
    if (status.state !== 'on') return false;
    try {
      await takeInbox();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const remote = await download();
        const merged = mergeData(await syncData(), remote?.data ?? {});
        await applySyncData(merged);
        if (remote && sameData(remote.data, merged)) break;
        if (await upload(merged, remote?.rev)) break;
        // Someone wrote the file since we read it: read again and merge their change too.
      }
    } catch (error) {
      // Remembered so the settings menu can say the last sync failed.
      await markAccount({ failedAt: Date.now() });
      throw error;
    }
    await markAccount({ lastSync: Date.now() });
    return true;
  });
}

// Adds the links waiting in the inbox (any http(s) link in each file, so a shared text with a
// link in it works too), then deletes those files. A link already saved is skipped.
async function takeInbox() {
  const response = await apiResponse('https://api.dropboxapi.com/2/files/list_folder', { body: JSON.stringify({ path: INBOX }), json: true });
  if (response.status === 409) return; // No inbox yet.
  if (!response.ok) throw new Error(`Dropbox inbox: ${response.status}`);
  const files = (await response.json()).entries.filter((entry) => entry['.tag'] === 'file');
  if (!files.length) return;
  for (const file of files) {
    const download = await apiResponse('https://content.dropboxapi.com/2/files/download', { arg: { path: file.path_lower } });
    if (!download.ok) continue;
    for (const link of (await download.text()).match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
      const url = normalizeUrl(link);
      if (!findByUrl((await getState()).products, url)) await saveProduct({ url });
    }
  }
  const entries = files.map((file) => ({ path: file.path_lower }));
  await apiResponse('https://api.dropboxapi.com/2/files/delete_batch', { body: JSON.stringify({ entries }), json: true });
}

async function markAccount(change) {
  const { [KEY]: account } = await chrome.storage.local.get(KEY);
  if (account) await chrome.storage.local.set({ [KEY]: { ...account, ...change } });
}

// Syncs a moment after the collection changes (a burst of changes becomes one sync).
// Only the collection: settings, and this module's own bookkeeping, must not start one.
// afterSync runs after each sync that went through (the picture copies, thumbs.js).
export function startDropboxSync(afterSync = () => {}) {
  let timer;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !['products', 'lists', 'shopFolders', 'deleted'].some((key) => key in changes)) return;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow().then((synced) => synced && afterSync()).catch(() => {}), SYNC_DELAY);
  });
}

async function download() {
  const response = await apiResponse('https://content.dropboxapi.com/2/files/download', { arg: { path: FILE } });
  if (response.status === 409) return null; // No file yet.
  if (!response.ok) throw new Error(`Dropbox download: ${response.status}`);
  const { rev } = JSON.parse(response.headers.get('dropbox-api-result'));
  try {
    return { data: JSON.parse(await response.text()), rev };
  } catch {
    return { data: {}, rev }; // Not readable: it gets replaced by the merged copy.
  }
}

// False when the file changed since `rev` was read.
async function upload(data, rev) {
  const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
  const response = await apiResponse('https://content.dropboxapi.com/2/files/upload', {
    arg: { path: FILE, mode, autorename: false, mute: true },
    body: JSON.stringify({ app: 'shopmarks', version: 2, ...data }, null, 2),
    contentType: 'application/octet-stream',
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error(`Dropbox upload: ${response.status}`);
  return true;
}

async function api(url, options) {
  const response = await apiResponse(url, options);
  if (!response.ok) throw new Error(`Dropbox: ${response.status}`);
  return response.json();
}

export async function apiResponse(url, { arg, body, json = false, contentType } = {}) {
  const headers = { Authorization: `Bearer ${await currentToken()}` };
  if (arg) headers['Dropbox-API-Arg'] = asciiJson(arg);
  if (json) headers['Content-Type'] = 'application/json';
  else if (contentType) headers['Content-Type'] = contentType;
  return fetch(url, { method: 'POST', headers, body });
}

async function currentToken() {
  if (accessToken && Date.now() < accessTokenExpires) return accessToken;
  const { [KEY]: account } = await chrome.storage.local.get(KEY);
  if (!account) throw new Error('Not connected to Dropbox');
  rememberAccess(await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken }));
  return accessToken;
}

function rememberAccess(token) {
  accessToken = token.access_token;
  accessTokenExpires = Date.now() + (token.expires_in - 60) * 1000;
}

async function tokenRequest(params) {
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ ...params, client_id: await dropboxAppKey() }),
  });
  if (!response.ok) throw new Error(`Dropbox sign-in: ${response.status}`);
  return response.json();
}

// Dropbox-API-Arg is a header, so anything outside ASCII must be escaped.
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function randomString() {
  return base64url(crypto.getRandomValues(new Uint8Array(48)));
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
