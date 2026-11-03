/*
 * The audio engine. Chrome closes a popup the moment you click away, so the sound lives here instead:
 * an offscreen document (reason AUDIO_PLAYBACK) that owns the <audio> element, the queue and the current track.
 * It only talks through runtime messages:
 *   in : { target: 'offscreen', cmd, ... }
 *   out: { type: 'state', state }       on every change (track, play/pause, queue)
 *        { type: 'progress', position, duration }   about once a second while playing
 */

const audio = new Audio();
audio.preload = 'auto';

let queue = [];      // [{ title, src, name, seconds }]
let index = -1;
let rec = null;      // { id, title, date, venue, url, servers } of the recording the queue comes from
let error = '';
let notice = '';     // 'Trying another archive.org server…' while a failing file is being retried
let candidate = 0;   // which address of the current track is being tried (see candidatesFor)
let round = 0;       // how many full passes over the addresses have failed
let wantPlay = false; // the listener wants sound (so a recovery after an error keeps playing)
let autoAdvance = false; // the current track started by itself (end of the previous one), not by a click
const preferred = {};   // recording id -> the address index that worked last, so the next track starts there
let pendingSeek = 0; // position to jump to once the file has loaded (restore after the document was closed)
let warmed = '';     // next track we already asked the browser to fetch
let lastProgress = 0;

function duration() {
  if (isFinite(audio.duration) && audio.duration > 0) {
    return audio.duration;
  }
  return queue[index] ? queue[index].seconds || 0 : 0;
}

function snapshot() {
  return {
    queue: queue,
    index: index,
    rec: rec,
    playing: !!queue[index] && !audio.paused && !audio.ended,
    position: audio.currentTime || 0,
    duration: duration(),
    volume: audio.volume,
    error: error,
    notice: notice
  };
}

function send(message) {
  chrome.runtime.sendMessage(message).catch(function () { /* nobody is listening right now */ });
}

function broadcast() {
  send({ type: 'state', state: snapshot() });
  updateMediaSession();
}

/**
 * Every address a track can be fetched from. archive.org/download redirects to one storage node, and some of those
 * nodes answer HTTP 500 (after a 5 second wait) for files that are fine on the item's original servers. So the
 * original servers (from the metadata) are tried first, then the redirecting address, then the rest.
 */
function candidatesFor(i) {
  var track = queue[i];
  if (!track) {
    return [];
  }

  var direct = [];
  var late = [];
  if (track.name && rec && Array.isArray(rec.servers)) {
    var encoded = track.name.split('/').map(encodeURIComponent).join('/');
    rec.servers.forEach(function (server) {
      var url = 'https://' + server.host + server.dir + '/' + encoded;
      // The item's original servers first; the "dn…" storage nodes are what archive.org/download redirects to anyway.
      (/^dn\d/.test(server.host) ? late : direct).push(url);
    });
  }

  var list = direct.concat([track.src], late);
  list = list.filter(function (url, i) { return list.indexOf(url) === i; });
  return list;
}

function startSource(resumeAt) {
  var list = candidatesFor(index);
  if (!list.length) {
    return;
  }

  pendingSeek = resumeAt || 0;
  audio.src = list[candidate % list.length];

  if (wantPlay) {
    audio.play().catch(function () { /* the 'error'/'pause' events report it */ });
  }
}

function load(i, autoplay, byItself) {
  if (!queue[i]) {
    return;
  }

  index = i;
  error = '';
  notice = '';
  warmed = '';
  round = 0;
  wantPlay = !!autoplay;
  autoAdvance = !!byItself;
  candidate = (rec && preferred[rec.id]) || 0;
  if (candidate >= candidatesFor(i).length) {
    candidate = 0;
  }

  startSource(pendingSeek);
  broadcast();
}

function next(byItself) {
  if (index + 1 < queue.length) {
    load(index + 1, true, byItself === true);
  }
}

function prev() {
  if ((audio.currentTime || 0) > 3 || index <= 0) {
    audio.currentTime = 0;
    broadcast();
    return;
  }
  load(index - 1, true);
}

function toggle() {
  if (!queue[index]) {
    return;
  }
  if (audio.paused) {
    wantPlay = true;
    audio.play().catch(function () {});
  } else {
    wantPlay = false;
    audio.pause();
  }
}

function stop() {
  wantPlay = false;
  notice = '';
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  queue = [];
  index = -1;
  rec = null;
  error = '';
  broadcast();
}

/* ---------------- audio events ---------------- */

audio.addEventListener('play', broadcast);
audio.addEventListener('pause', broadcast);
audio.addEventListener('playing', broadcast);
audio.addEventListener('volumechange', broadcast);
audio.addEventListener('loadedmetadata', function () {
  if (pendingSeek > 0) {
    audio.currentTime = Math.min(pendingSeek, Math.max(0, audio.duration - 1));
    pendingSeek = 0;
  }
  broadcast();
});

audio.addEventListener('ended', function () {
  if (index + 1 < queue.length) {
    next(true);
  } else {
    broadcast();
  }
});

audio.addEventListener('playing', function () {
  // This address works: remember it for the rest of the recording and clear any retry message.
  if (rec) {
    preferred[rec.id] = candidate;
  }
  if (notice || error) {
    notice = '';
    error = '';
    broadcast();
  }
});

audio.addEventListener('error', function () {
  var list = candidatesFor(index);
  var resumeAt = (audio.currentTime || 0) > 2 ? audio.currentTime : 0;

  // 1) another address of the same file
  if (candidate + 1 < list.length) {
    candidate += 1;
    notice = 'Trying another archive.org server…';
    broadcast();
    startSource(resumeAt);
    return;
  }

  // 2) all addresses failed: archive.org may just be busy, go round again after a short wait
  if (round < 2) {
    round += 1;
    candidate = 0;
    notice = 'archive.org is not answering, trying again…';
    broadcast();
    var current = index;
    window.setTimeout(function () {
      if (index === current && audio.error) {
        startSource(resumeAt);
      }
    }, 1500 * round);
    return;
  }

  // 3) give up. A track you picked yourself stays put with a message; during automatic play we move on.
  notice = '';
  error = 'This track could not be loaded from archive.org right now.';
  wantPlay = false;
  audio.pause();
  broadcast();
  if (autoAdvance && index + 1 < queue.length) {
    window.setTimeout(function () { next(true); }, 1200);
  }
});

audio.addEventListener('timeupdate', function () {
  var now = Date.now();
  var left = duration() - (audio.currentTime || 0);

  // Warm the cache with the next file shortly before the end, so the gap between tracks stays small.
  if (left > 0 && left < 12 && queue[index + 1] && warmed !== queue[index + 1].src) {
    warmed = queue[index + 1].src;
    var warm = new Audio();
    warm.preload = 'auto';
    warm.src = warmed;
  }

  if (now - lastProgress > 900) {
    lastProgress = now;
    send({ type: 'progress', position: audio.currentTime || 0, duration: duration() });
  }
});

/* ---------------- Media Session (keyboard media keys, Chrome's media hub) ---------------- */

function updateMediaSession() {
  if (!('mediaSession' in navigator)) {
    return;
  }

  var track = queue[index];
  if (!track) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
    return;
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: 'Motorpsycho',
    album: rec ? rec.title : 'archive.org'
  });
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', toggle);
  navigator.mediaSession.setActionHandler('pause', toggle);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('seekto', function (details) {
    if (typeof details.seekTime === 'number') {
      audio.currentTime = details.seekTime;
    }
  });
}

/* ---------------- commands ---------------- */

chrome.runtime.onMessage.addListener(function (message) {
  if (!message || message.target !== 'offscreen') {
    return;
  }

  switch (message.cmd) {
    case 'playQueue':
      queue = message.queue || [];
      rec = message.rec || null;
      load(message.index || 0, true);
      break;
    case 'restore':
      // The document had been closed (Chrome does that after a while of silence): bring the queue back, paused.
      queue = message.state.queue || [];
      rec = message.state.rec || null;
      pendingSeek = message.state.position || 0;
      if (typeof message.state.volume === 'number') {
        audio.volume = message.state.volume;
      }
      load(message.state.index || 0, false);
      break;
    case 'jump':
      load(message.index, true);
      break;
    case 'toggle':
      toggle();
      break;
    case 'play':
      if (queue[index] && audio.paused) { toggle(); }
      break;
    case 'pause':
      if (!audio.paused) { toggle(); }
      break;
    case 'next':
      next();
      break;
    case 'prev':
      prev();
      break;
    case 'seek':
      if (typeof message.position === 'number') {
        audio.currentTime = Math.max(0, message.position);
        broadcast();
      }
      break;
    case 'volume':
      audio.volume = Math.max(0, Math.min(1, message.value));
      break;
    case 'stop':
      stop();
      break;
  }
});

// Tell the service worker we are up (it may have a state to hand over).
send({ type: 'offscreenReady' });
