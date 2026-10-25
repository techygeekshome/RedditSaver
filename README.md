<div align="center">

<img src="https://raw.githubusercontent.com/techygeekshome/RedditSaver/main/icons/icon128.png" alt="Reddit Saver logo" width="96" height="96">

# Reddit Saver: Download Reddit Images, Galleries and Videos

**Save the pictures, galleries and videos (with sound) from a Reddit post, user or subreddit in one ZIP. Free, no tracking.**

[![Version](https://img.shields.io/github/v/release/techygeekshome/RedditSaver?label=version&color=4c9bff)](https://github.com/techygeekshome/RedditSaver/releases)
[![Platform](https://img.shields.io/badge/browser-Chrome%20%7C%20Edge%20%7C%20Firefox-0078d4)](#%EF%B8%8F-download--install)
[![License](https://img.shields.io/badge/license-GPL--3.0-3fb950)](LICENSE)
[![Made by TechyGeeksHome](https://img.shields.io/badge/made%20by-TechyGeeksHome-b191f2)](https://techygeekshome.info)
[![Support on Ko-fi](https://img.shields.io/badge/support-Ko--fi-ff5e5b)](https://ko-fi.com/techygeekshome)

[Download](#%EF%B8%8F-download--install) · [Features](#-what-it-does) · [Privacy](#-privacy) · [Full guide](https://techygeekshome.info/browser-extensions/reddit-saver/) · [License](#-license)

</div>

---

## 🎬 See it in action

[![Reddit Saver demo video](https://img.youtube.com/vi/qJMmADNN7wY/maxresdefault.jpg)](https://www.youtube.com/watch?v=qJMmADNN7wY)

---

Save the pictures, galleries and videos from a Reddit post, a user's posts or a subreddit in one go. Pictures come down at full size and Reddit videos as normal MP4 files with sound, all in a single ZIP file.

The full guide, with every step explained, is on [TechyGeeksHome](https://techygeekshome.info/browser-extensions/reddit-saver/).

## 📸 Screenshots

<p float="left">
  <img src="https://raw.githubusercontent.com/techygeekshome/RedditSaver/main/screenshots/reddit-saver-download-zip.jpg" width="49%" />
  <img src="https://raw.githubusercontent.com/techygeekshome/RedditSaver/main/screenshots/reddit-saver-open-subreddit.jpg" width="49%" />
</p>
<p float="left">
  <img src="https://raw.githubusercontent.com/techygeekshome/RedditSaver/main/screenshots/reddit-saver-reading.jpg" width="49%" />
  <img src="https://raw.githubusercontent.com/techygeekshome/RedditSaver/main/screenshots/reddit-saver-real-gallery.jpg" width="49%" />
</p>
<p float="left">
  <img src="https://raw.githubusercontent.com/techygeekshome/RedditSaver/main/screenshots/reddit-saver-results.jpg" width="49%" />
  <img src="https://raw.githubusercontent.com/techygeekshome/RedditSaver/main/screenshots/reddit-saver-videos.jpg" width="49%" />
</p>

## ✨ What it does

- **Posts, users and subreddits.** Open a post to save just that post, a user's profile to save their posts, or a subreddit (hot, new, top, rising) to save its posts. New Reddit and old Reddit both work.
- **Full-size pictures**: the original upload from `i.redd.it`, not the resized preview.
- **Every picture in a gallery**, in order, with its caption. Animated gallery pictures come down as GIFs.
- **Reddit videos with sound.** Reddit keeps the picture and the sound of a video in separate files (DASH). Reddit Saver downloads both and joins them into one normal MP4, with no extra app.
- **Removes duplicates** (crossposts of the same pictures, near-identical copies), keeping the biggest copy, and has a minimum size filter.
- **You choose what goes in**: a preview grid with tick boxes, an Images and Videos switch, and a Save button on each video.
- **One ZIP download**, with the account name and date in every file name (`author_date_postid_n.jpg`), plus an optional CSV of titles, captions and links.

## 🚫 What it won't do

- **Videos from other sites** (YouTube, Twitch and so on) and links to other websites are not downloaded. For pictures posted as a link to another site (such as Imgur), Reddit Saver saves Reddit's own full-size copy, and you can switch that off.
- **Comments** are not read, only the posts themselves.
- **More than about 1,000 posts** from one listing: that is as far back as Reddit lets anyone page through a subreddit or profile.

## ⬇️ Download & install

Pick the download for your browser from the [latest release](https://github.com/techygeekshome/RedditSaver/releases/latest).

| Browser | Download |
|---|---|
| Chrome, Brave, Opera, Vivaldi | `RedditSaver-chrome.zip` |
| Microsoft Edge | `RedditSaver-edge.zip` |
| Firefox (142 or newer) | `RedditSaver-firefox.zip` |

`RedditSaver.zip` is the same package as the Chrome and Edge downloads.

### Chrome, Edge, Brave, Opera and Vivaldi

1. Unzip the download somewhere you'll keep it.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the `reddit-saver` folder.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick `RedditSaver-firefox.zip`.

Firefox removes temporary add-ons when it closes. In Firefox, the first time you click the icon it asks for access to the sites it works with: choose **Allow**.

### Build it yourself

The code in this repo is the Chromium version. `manifest.firefox.json` is the Firefox manifest. Run `./build.sh` to make every package in `dist/`.

## 🧭 How to use

1. Open a Reddit post, a user's profile or a subreddit. Sign in to Reddit first if you normally do.
2. Click the Reddit Saver icon. A results tab opens and fills up as it reads the posts. Leave the Reddit tab open until it has finished reading.
3. Pick how many posts to read, and tick or untick anything you want.
4. Click **Download ZIP**, or **Save this video** to save one video on its own.

## ⚙️ How it works

- `background.js` reads the reddit.com address you are on (post, user or subreddit, with its sort) when you click the icon.
- `site.js` reads Reddit's own `.json` version of the page (for example `/r/name/top.json?t=week`). It runs that request inside your Reddit tab, so it is exactly the request the site itself would make, with your own sign-in and settings. If you close the tab, it carries on from the extension. It reads 100 posts at a time, one second apart, and backs off if Reddit asks it to slow down.
- Pictures come from `i.redd.it` (originals), `preview.redd.it` and `external-preview.redd.it` (Reddit's copies). Gallery pictures are turned from their preview address back into the original.
- For videos, `streams.js` reads the DASH playlist on `v.redd.it`, picks the best quality and the sound, and `mp4.js` joins them into one normal MP4. If the playlist is missing it tries the HLS playlist, then the plain video file plus Reddit's separate sound file.
- `results.js` shows the grid, removes duplicates and builds the ZIP in your browser (`zip.js`).

## 🔒 Privacy

Reddit Saver talks only to Reddit: reddit.com and Reddit's picture and video servers (i.redd.it, preview.redd.it, external-preview.redd.it and v.redd.it). It reads only what you can already see on Reddit. Your Reddit sign-in stays in your browser: Reddit Saver never reads, stores or sends it. It has no account, no analytics and sends nothing anywhere else. The only things it stores are your settings and the current download list, on your own computer.

## ☕ Support

Reddit Saver is free and always will be. If it saved you some time, you can [buy us a coffee on Ko-fi](https://ko-fi.com/techygeekshome). Welcome, but never expected.

## 🐛 Support & contributing

Found a bug or have a request? [Open an issue](https://github.com/techygeekshome/RedditSaver/issues) or [get in touch](https://techygeekshome.info/contact/). Pull requests are welcome.

## 📄 License

GPL-3.0. Free for everyone, including commercial use. `lib-mux-mp4.js` is mux.js by Brightcove, under the Apache-2.0 licence (`LICENSE-mux.js.txt`).

Reddit Saver is an independent tool made by [TechyGeeksHome](https://techygeekshome.info). It is not affiliated with, endorsed by or connected to Reddit, Inc.. The pictures and videos you save still belong to the people who posted them. Only save what you have the right to keep.

© 2026 TechyGeeksHome.

---

<div align="center">

Made with ❤️ by [**TechyGeeksHome**](https://techygeekshome.info)

[Website](https://techygeekshome.info) · [YouTube](https://www.youtube.com/channel/UCtEuFj1SMLiuRoucD1hv8dA) · [X](https://x.com/TechyGeeks1) · [Instagram](https://www.instagram.com/andrewarmstrongtgh/)

</div>
