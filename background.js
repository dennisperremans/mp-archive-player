/*
 * Service worker: starts the offscreen audio engine on demand, remembers the last player state (so it survives
 * Chrome closing the idle offscreen document and the worker itself), relays the state to every open tab for the
 * floating mini player, and opens the full player window.
 */

const OFFSCREEN_URL = 'offscreen.html';
const PLAYER_WINDOW_URL = 'app.html?window=1';

let creating = null;

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

/** @returns {Promise<boolean>} true when the document was created just now */
async function ensureOffscreen() {
  if (await offscreenExists()) {
    return false;
  }

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play Motorpsycho recordings from archive.org while the popup is closed.'
      })
      .finally(function () { creating = null; });
  }

  await creating;
  return true;
}

async function loadSavedState() {
  const data = await chrome.storage.session.get('playerState');
  return data.playerState || null;
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, message)).catch(function () {});
}

async function handleCommand(message) {
  const cmd = message.cmd;

  if (cmd === 'maximize') {
    await openPlayerWindow();
    return;
  }

  const saved = await loadSavedState();

  if (cmd === 'stop' && !(await offscreenExists())) {
    await chrome.storage.session.remove('playerState');
    await broadcastToTabs(emptyState());
    return;
  }

  const created = await ensureOffscreen();

  // A fresh offscreen document knows nothing: hand it the last queue first (unless we are starting a new one).
  if (created && cmd !== 'playQueue' && saved && saved.queue && saved.queue.length) {
    await sendToOffscreen({ cmd: 'restore', state: saved });
  }

  await sendToOffscreen(Object.assign({}, message, { type: undefined }));
}

function emptyState() {
  return { queue: [], index: -1, rec: null, playing: false, position: 0, duration: 0, volume: 1, error: '' };
}

async function broadcastToTabs(state) {
  // No URL filter: without the "tabs" permission Chrome only shows tab URLs on hosts we have access to, so a filtered
  // query would find nothing. Tabs without our content script (chrome:// pages, the Web Store) just reject the message.
  const tabs = await chrome.tabs.query({});
  tabs.forEach(function (tab) {
    if (tab.id !== undefined && tab.id >= 0) {
      chrome.tabs.sendMessage(tab.id, { type: 'state', state: state }).catch(function () { /* no content script there */ });
    }
  });
}

async function openPlayerWindow() {
  const stored = await chrome.storage.session.get('playerWindowId');

  if (stored.playerWindowId) {
    try {
      await chrome.windows.update(stored.playerWindowId, { focused: true, drawAttention: true });
      return;
    } catch (error) { /* the window is gone, open a new one */ }
  }

  const created = await chrome.windows.create({ url: PLAYER_WINDOW_URL, type: 'popup', width: 480, height: 740 });
  await chrome.storage.session.set({ playerWindowId: created.id });
}

chrome.windows.onRemoved.addListener(async function (windowId) {
  const stored = await chrome.storage.session.get('playerWindowId');
  if (stored.playerWindowId === windowId) {
    await chrome.storage.session.remove('playerWindowId');
  }
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') {
    return;
  }

  // From the offscreen audio engine
  if (message.type === 'state') {
    chrome.storage.session.set({ playerState: message.state });
    broadcastToTabs(message.state);
    return;
  }

  // From the popup, the player window or a tab's mini player
  if (message.type === 'command') {
    handleCommand(message).then(function () { sendResponse({ ok: true }); }, function (error) { sendResponse({ ok: false, error: String(error) }); });
    return true;
  }

  if (message.type === 'getState') {
    loadSavedState().then(function (state) { sendResponse({ state: state || emptyState() }); });
    return true;
  }
});
