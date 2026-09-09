# Listen Mode

**Listen to YouTube without the video.**

Listen Mode is a browser extension for Chrome and Safari that turns any YouTube video into an audio-only stream. It hides the video, switches the stream to the lowest quality, and shows a calm audio visualizer instead. You keep the sound, skip the picture, and use a fraction of the data.

Ideal for music, podcasts, lectures, and long videos on mobile data or slow connections.

## Features

- **One switch.** Turn Listen Mode on or off from the toolbar popup or with a keyboard shortcut (`Alt+Shift+A` on Windows/Linux, `Option+Shift+A` on macOS).
- **No reloads.** Turning it on or off keeps your place in the video.
- **Choose the quality to return to.** Pick Auto, 360p, 480p, 720p, 1080p, 1440p, or 4K. Applied instantly when you turn Listen Mode off.
- **Now Playing controls.** Play, pause, skip 10 seconds, scrub, set speed and volume — all from the popup.
- **Usage stats.** See how much data you used and saved, plus listening time, for this month or all time.
- **Your look.** Six gradient presets, a custom color, or your own background image for the visualizer.
- **Light and dark.** The popup follows your system appearance.
- **Arabic and English.** Full right-to-left support.
- **Private by design.** Nothing leaves your device. No accounts, no analytics, no ads.

## Install

### Safari (macOS)
Available on the Mac App Store. Search for **Listen Mode**, install, then enable it in Safari → Settings → Extensions.

### Chrome
1. Download or clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.

## How it works

Listen Mode asks the YouTube player for its lowest video quality (144p) and hides the video element. The audio track is unaffected. When you turn it off, the player is set back to the quality you chose. Data estimates use typical YouTube bitrates: about 0.75 MB/min at 144p versus 18.75 MB/min at 720p.

## Privacy

Listen Mode does not collect, store, or send any personal data. Preferences and statistics are stored locally in your browser. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## Development

- `manifest.json` — Manifest V3 configuration
- `background.js` — service worker: shortcut, badge, script injection on navigation
- `content.js` — player control, overlay, statistics
- `inject.js` — page-context bridge to the YouTube player API
- `popup.html` / `popup.js` / `popup.css` — toolbar popup
- `overlay.css` — visualizer overlay
- `icons/variants/` — icon sets (A–D); activate one with `scripts/set-icon.sh`

The Safari app lives in a separate Xcode project (`YouTube Audio Mode.xcodeproj`) that wraps these same files.

## Credits

Listen Mode began as a fork of [YouTube Audio Mode](https://github.com/devahmedadli/youtube-audio-mode) by Ahmed Adli (MIT). The popup, icons, quality restore flow, reload-free toggling, and Safari packaging were rebuilt by Mo Mahdy.

## License

MIT
