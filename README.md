# Motorpsycho Archive Player

A Chrome extension to search and play the Motorpsycho live recordings from the
[MotorpsychoBand collection on archive.org](https://archive.org/details/MotorpsychoBand).

- **Search**: type a venue, city, song, taper or year. Uses archive.org's own search
  (`advancedsearch`), so every word can be the start of a word in the title, venue or
  description, or a whole word anywhere in the item's text (song titles).
- **Year filter** (with the number of recordings per year) and sort newest/oldest first.
- **Recording view**: all MP3 tracks with their length, Play all, or start from any track.
- **Keeps playing** while the popup is closed, and while you browse. Sound runs in an
  offscreen document, so it does not depend on the popup or on one tab.
- **Mini player**: a small round button in the corner of every page. Hover it and it slides
  open with previous, play/pause, next, maximize (opens the full player in its own window)
  and stop. Drag it anywhere, the position is remembered.
- Hardware media keys and Chrome's media controls work (Media Session).

## Install (developer mode)

1. Open `chrome://extensions`
2. Switch on **Developer mode** (top right)
3. **Load unpacked** and pick this folder (`mp-archive-player`)
4. Pin the extension from the puzzle-piece menu so the toolbar icon is easy to reach

Needs Chrome 116 or newer.

## How it fits together

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3. Permissions: `offscreen`, `storage`, and access to archive.org. |
| `app.html` / `app.js` / `app.css` | The UI: used as the toolbar popup and (`?window=1`) as the maximized window. Talks to archive.org and sends commands. |
| `background.js` | Service worker: creates the offscreen audio document, remembers the last state, relays state to every tab, opens the player window. |
| `offscreen.html` / `offscreen.js` | The audio engine: one `<audio>` element, the queue, Media Session. Chrome closes this document after a while of silence; the worker then restores queue, track and position the next time you press play. |
| `content.js` | The floating mini player (shadow DOM, so page CSS cannot touch it). |

Messages: UI and mini player send `{type: 'command', cmd: ...}` to the worker, which starts the
offscreen document if needed and forwards the command. The offscreen document answers with
`{type: 'state', state}` (every change) and `{type: 'progress'}` (about once a second, popup only).

## When archive.org cannot deliver a file

`archive.org/download/…` redirects to one storage node, and some nodes answer HTTP 500 (after about 5 seconds)
for files that are fine on the item's original servers (for example every file of `mp2025-05-13`). The player
therefore tries, per track: the item's original servers (from the metadata), then the redirecting address, then
the remaining nodes; if everything fails it waits and goes round again (twice). The address that worked is
remembered for the rest of the recording. Only when all of that fails, a track you picked yourself stays put
with a message; during automatic play it moves on to the next track.

## Good to know

- The mini player does not show on pages where Chrome does not allow extensions
  (`chrome://` pages, the Chrome Web Store, the new tab page). Use the toolbar icon there.
- Recordings and years are cached for 12 hours in `chrome.storage.local`.
- Only the VBR MP3 derivatives are played (never FLAC), same as on mpdb.no.
- No data is sent anywhere except requests to archive.org.
