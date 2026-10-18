# TubeVault

A Chrome extension for saving YouTube channels into niche folders.

## Install (one time)

TubeVault isn't in the Chrome Web Store, so you load it yourself. It takes about a minute and works in Chrome and other Chromium browsers (Edge, Brave, Arc, …).

1. **Get the code.** Either:
   - clone it: `git clone https://github.com/TheCodedMedic/TubeVault.git`
   - or click **Code → Download ZIP** on GitHub and unzip it.
2. Open `chrome://extensions` in your browser.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `TubeVault` folder (the one containing `manifest.json`).
5. Pin TubeVault from the puzzle-piece menu so the icon stays in the toolbar.
6. Refresh any YouTube tabs that were already open.

**Updating:** `git pull` (or download the ZIP again), then click the reload ↻ icon on the TubeVault card in `chrome://extensions` and refresh YouTube.

## Use

- **Save a channel:** on a channel page, video or Short, click the red **+ TubeVault** button (next to Subscribe, or bottom-right on Shorts), then pick a folder or create one. The saved link is always the channel page, never the video.
- **Already saved?** The button turns grey and shows the folder name. Click it to move or remove the channel.
- **Open the vault:** click the TubeVault toolbar icon. A sidebar opens with your folders.
- **Organise:** drag channels between folders or up and down inside one. Drag a folder's header to reorder folders. Double-click a folder name, or use ✎, to rename it.
- **Copy a folder:** 📋 copies every channel link in the folder to your clipboard, one per line.
- **Delete a folder:** 🗑 asks whether to keep its channels (they move to Unsorted) or delete them too.
- **Open a channel:** click it to open it in the current tab. Cmd-click opens it in a new tab.
- **Add from the sidebar:** **+ Add current channel** saves the channel on screen to Unsorted.
- **Backup:** the **Export backup** and **Import** links at the bottom. Data is stored locally in Chrome only.

## Warm Tracker (second tab)

Warm up a new channel for 7 days before your first upload. You get a 0–100 Trust Score and a verdict: 🔴 Keep warming, 🟡 Almost there, 🟢 Good to start.

- **Start:** sign in to YouTube as your new channel, open the Warm Tracker tab, and click **+ Add @yourchannel**. You can track several channels at once.
- **Auto-tracked on YouTube:** watch time (one clock, so videos playing at the same time aren't added together), subscribes, likes, comments and searches.
  - Corrections: drag the watch-time slider, or use −/+ on the other counts.
- **Is it tracking?** The status line at the top of the Warm Tracker tab tells you, e.g. "● Tracking Paper Balance · video playing, counting watch time · counted 5s ago". Tracking runs inside your youtube.com tabs, so the sidebar does **not** need to be open. If you see a ⚠ instead:
  - **"Not tracking on this tab":** press **Reload tab** (this happens when the extension was updated after the tab opened).
  - **"Not counting … isn't in the Warm Tracker":** the channel you're signed in as isn't added yet. Add it with ↻.
  - **"This tab isn't signed in":** sign in to YouTube.
- **Warnings:**
  - **On the YouTube page:** subscribing too fast (3 in 2 minutes), more than 5 subscribes in a day, copy-pasted comments, and comments under 6 words.
  - **In the tracker:** the same warnings show on that day's counts.
- **Profile stays up to date:** a channel's name, @username and picture can change, but its channel ID never does. TubeVault matches by ID, so a renamed channel is never mistaken for a new one.
  - **Updates when:** you open the sidebar, press ↻, or (every few hours, even with no YouTube tab open) in the background.
  - **You're told what changed:** e.g. "Updated Paper Balance: username and picture changed on YouTube."
- **Toolbar badge:** shows today's tasks done (e.g. 3/5), or ✓ when the day is complete.
- **Daily reminder:** a notification at the time you choose (default 7 pm) if today isn't done.
- **First uploads:** shown from day 1 but locked.
  - **Day 5:** you can unlock it early. **Day 7, or once the channel is 🟢:** it unlocks by itself.
  - **Once unlocked:** TubeVault checks your channel's public feed every 30 minutes. It automatically tracks videos published since the warm-up started (up to 5) and fills in their views. **Refresh** checks right away.
  - **Check-ins:** at 8h, 24h, 48h and 72h. Impressions, CTR and traffic source exist only in YouTube Studio: **Open in Studio** goes straight to the video's Reach tab.
  - **Verdicts:** each video gets one ("YouTube is pushing it" / "Not being pushed"), and the channel gets an overall call.

### How the Trust Score works (0–100)

YouTube doesn't publish a trust score. This is TubeVault's own checklist score for how thoroughly a new channel has been warmed up; it is not what YouTube secretly thinks.

| Part | Points |
|---|---|
| Gmail age (you enter the month it was created) | 20 |
| Account security (2-step verification, phone verified) | 10 |
| Channel basics (name, picture, feature eligibility, Made for Kids off, niche, ID, VidIQ) | 10 |
| Warm-up days (best 7 days: 2h watching, 3–5 subscribes, 2+ comments, 5+ likes, 4+ searches) | 56 |
| Same device all week | 4 |

🟢 **Good to start** needs 80+, 2-step on, phone verified, and 7 warm-up days done.

## Files

- `manifest.json`: extension config (Manifest V3, side panel)
- `background.js`: opens the side panel when you click the icon
- `shared/store.js`: folders and channels storage (`chrome.storage.local`)
- `content/content.js`: the + button on YouTube and channel detection
- `shared/warm.js`: Warm Tracker data, Trust Score and upload verdicts
- `content/tracker.js`: detects watching, subscribes, likes, comments and searches on YouTube
- `sidepanel/`: the sidebar UI (`warm.js` / `warm.css` = Warm Tracker tab)

## Privacy

Everything is stored locally in your browser (`chrome.storage.local`). TubeVault has no server, no account and no analytics. It only talks to YouTube.

## Author and licence

Created by **Ufuoma Oboh** ([@TheCodedMedic](https://github.com/TheCodedMedic)).
Released under the [MIT License](LICENSE). © 2026 Ufuoma Oboh.
