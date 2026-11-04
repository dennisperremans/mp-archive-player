/*
 * Floating mini player. While something is playing (or paused mid-track) a small round button sits in the corner of
 * every page. Hover it (or tab to it) and it slides open: previous, play/pause, next, maximize, stop.
 * Drag it anywhere; the position is remembered. It lives in a shadow root so the page's CSS cannot touch it.
 */
(function () {
  'use strict';

  if (window.top !== window || window.__mpArchivePlayer) {
    return;
  }
  window.__mpArchivePlayer = true;

  var HOST_ID = 'mp-archive-player-host';
  var state = null;
  var host = null;
  var root = null;
  var nodes = {};
  var pos = { fx: 1, fy: 1 }; // 0..1 inside the free area: 1,1 = bottom right corner
  var closeTimer = 0;

  var CSS = '\
:host { all: initial; }\
* { box-sizing: border-box; }\
.wrap { position: fixed; z-index: 2147483647; display: flex; align-items: center; font: 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #eef1ef; }\
.wrap.left { flex-direction: row; }\
.wrap.right { flex-direction: row-reverse; }\
.disc { position: relative; flex: none; width: 46px; height: 46px; padding: 0; background: #181f21; border: 2px solid #fff85f; border-radius: 50%; box-shadow: 0 6px 18px rgba(0,0,0,.45); cursor: pointer; display: flex; align-items: center; justify-content: center; touch-action: none; }\
.disc:hover { background: #222b2e; }\
.disc:focus-visible, .btn:focus-visible { outline: 2px solid #fff85f; outline-offset: 2px; }\
.bars { display: none; align-items: flex-end; gap: 3px; height: 16px; }\
.bars i { width: 3px; height: 30%; background: #fff85f; }\
.playing .bars { display: flex; }\
.playing .bars i { animation: b .8s ease-in-out infinite alternate; }\
.bars i:nth-child(2) { animation-delay: .2s; }\
.bars i:nth-child(3) { animation-delay: .4s; }\
@keyframes b { from { height: 20%; } to { height: 100%; } }\
.tri { width: 0; height: 0; margin-left: 3px; border-top: 7px solid transparent; border-bottom: 7px solid transparent; border-left: 12px solid #fff85f; }\
.playing .tri { display: none; }\
.panel { display: flex; align-items: center; gap: 4px; max-width: 0; height: 46px; overflow: hidden; opacity: 0; background: #181f21; border: 0 solid #fff85f; box-shadow: 0 6px 18px rgba(0,0,0,.45); white-space: nowrap; transition: max-width .22s ease, opacity .15s ease, padding .22s ease; }\
.wrap.left .panel { border-radius: 0 23px 23px 0; margin-left: -23px; padding-left: 0; }\
.wrap.right .panel { border-radius: 23px 0 0 23px; margin-right: -23px; padding-right: 0; }\
.wrap.open .panel { max-width: 380px; opacity: 1; border-width: 2px; }\
.wrap.left.open .panel { padding: 0 12px 0 30px; }\
.wrap.right.open .panel { padding: 0 30px 0 12px; }\
.text { width: 150px; min-width: 0; margin-right: 6px; }\
.t { display: block; overflow: hidden; text-overflow: ellipsis; font-size: 11px; font-weight: 800; letter-spacing: .6px; text-transform: uppercase; color: #fff85f; }\
.r { display: block; overflow: hidden; text-overflow: ellipsis; font-size: 10px; color: rgba(238,241,239,.7); }\
.btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; background: none; border: 0; border-radius: 50%; color: #eef1ef; cursor: pointer; }\
.btn:hover { background: rgba(255,255,255,.12); color: #fff85f; }\
.btn svg { width: 16px; height: 16px; fill: currentColor; }\
.btn.stroke svg { fill: none; stroke: currentColor; stroke-width: 2; }\
.btn .pause { display: none; }\
.playing .btn .pause { display: block; }\
.playing .btn .play { display: none; }\
@media (prefers-reduced-motion: reduce) { .bars i { animation: none !important; height: 60% !important; } .panel { transition: none; } }';

  var ICONS = {
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5l11 7-11 7z"/></svg>',
    play: '<svg class="play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg class="pause" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    max: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-8 8M10 6H5v13h13v-5"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(function () { return null; });
    } catch (error) {
      // The extension was reloaded or removed: this old script has no purpose any more.
      destroy();
      return Promise.resolve(null);
    }
  }

  function command(cmd) {
    send({ type: 'command', cmd: cmd });
  }

  function button(className, label, svg, handler) {
    var node = document.createElement('button');
    node.type = 'button';
    node.className = 'btn ' + className;
    node.setAttribute('aria-label', label);
    node.title = label;
    node.innerHTML = svg;
    node.addEventListener('click', handler);
    return node;
  }

  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'wrap right';
    nodes.wrap = wrap;

    var disc = document.createElement('button');
    disc.type = 'button';
    disc.className = 'disc';
    disc.setAttribute('aria-label', 'Archive player: play or pause');
    disc.innerHTML = '<span class="tri"></span><span class="bars"><i></i><i></i><i></i></span>';
    nodes.disc = disc;

    var panel = document.createElement('div');
    panel.className = 'panel';
    var text = document.createElement('div');
    text.className = 'text';
    nodes.title = document.createElement('span');
    nodes.title.className = 't';
    nodes.rec = document.createElement('span');
    nodes.rec.className = 'r';
    text.appendChild(nodes.title);
    text.appendChild(nodes.rec);

    panel.appendChild(text);
    panel.appendChild(button('', 'Previous track', ICONS.prev, function () { command('prev'); }));
    panel.appendChild(button('', 'Play or pause', ICONS.play, function () { command('toggle'); }));
    panel.appendChild(button('', 'Next track', ICONS.next, function () { command('next'); }));
    panel.appendChild(button('stroke', 'Open the full player', ICONS.max, function () { command('maximize'); }));
    panel.appendChild(button('stroke', 'Stop', ICONS.stop, function () { command('stop'); }));

    wrap.appendChild(disc);
    wrap.appendChild(panel);
    root.appendChild(wrap);

    wrap.addEventListener('mouseenter', open);
    wrap.addEventListener('mouseleave', scheduleClose);
    wrap.addEventListener('focusin', open);
    wrap.addEventListener('focusout', scheduleClose);

    setupDrag(disc);
    document.documentElement.appendChild(host);
    place();
    window.addEventListener('resize', place);
  }

  function open() {
    window.clearTimeout(closeTimer);
    nodes.wrap.classList.add('open');
  }

  function scheduleClose() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(function () {
      if (!nodes.wrap.matches(':focus-within')) { nodes.wrap.classList.remove('open'); }
    }, 450);
  }

  /** Fractions -> pixels; the panel opens towards the middle of the screen. */
  function place() {
    if (!nodes.wrap) { return; }
    var size = 46;
    var margin = 16;
    var x = margin + pos.fx * Math.max(0, window.innerWidth - size - margin * 2);
    var y = margin + pos.fy * Math.max(0, window.innerHeight - size - margin * 2);
    nodes.wrap.style.left = '';
    nodes.wrap.style.top = Math.round(y) + 'px';
    var onRight = pos.fx > 0.5;
    nodes.wrap.classList.toggle('right', onRight);
    nodes.wrap.classList.toggle('left', !onRight);
    if (onRight) {
      nodes.wrap.style.right = Math.round(window.innerWidth - x - size) + 'px';
      nodes.wrap.style.left = 'auto';
    } else {
      nodes.wrap.style.left = Math.round(x) + 'px';
      nodes.wrap.style.right = 'auto';
    }
  }

  function setupDrag(disc) {
    var start = null;
    var moved = false;

    disc.addEventListener('pointerdown', function (event) {
      start = { x: event.clientX, y: event.clientY, fx: pos.fx, fy: pos.fy };
      moved = false;
      disc.setPointerCapture(event.pointerId);
    });

    disc.addEventListener('pointermove', function (event) {
      if (!start) { return; }
      var dx = event.clientX - start.x;
      var dy = event.clientY - start.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) { return; }
      moved = true;
      var freeX = Math.max(1, window.innerWidth - 46 - 32);
      var freeY = Math.max(1, window.innerHeight - 46 - 32);
      pos.fx = Math.min(1, Math.max(0, start.fx + dx / freeX));
      pos.fy = Math.min(1, Math.max(0, start.fy + dy / freeY));
      place();
    });

    disc.addEventListener('pointerup', function (event) {
      if (!start) { return; }
      disc.releasePointerCapture(event.pointerId);
      start = null;
      if (moved) {
        try { chrome.storage.local.set({ miniPos: pos }); } catch (error) { /* ignore */ }
        suppressClick = true;
        window.setTimeout(function () { suppressClick = false; }, 0);
      }
    });

    disc.addEventListener('click', function () {
      if (suppressClick) { return; }
      command('toggle');
    });
  }
  var suppressClick = false;

  function render() {
    var track = state && state.queue && state.queue[state.index];

    if (!track) {
      if (host) { host.remove(); host = null; nodes = {}; }
      return;
    }

    if (!host) { build(); }
    if (!host.isConnected) { document.documentElement.appendChild(host); }

    nodes.wrap.classList.toggle('playing', !!state.playing);
    nodes.title.textContent = track.title;
    nodes.rec.textContent = state.rec ? [state.rec.date, state.rec.venue].filter(Boolean).join(' · ') : '';
  }

  function destroy() {
    if (host) { host.remove(); host = null; nodes = {}; }
    window.__mpArchivePlayer = false;
  }

  try {
    chrome.runtime.onMessage.addListener(function (message) {
      if (message && message.type === 'state') {
        state = message.state;
        render();
      }
    });

    chrome.storage.local.get('miniPos').then(function (data) {
      if (data.miniPos && typeof data.miniPos.fx === 'number') { pos = data.miniPos; }
      return send({ type: 'getState' });
    }).then(function (response) {
      if (response && response.state) {
        state = response.state;
        render();
      }
    });
  } catch (error) {
    destroy();
  }
}());
