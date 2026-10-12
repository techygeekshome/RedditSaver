#!/usr/bin/env bash
# Builds the release packages into dist/.
#   RedditSaver.zip          Chrome, Edge, Brave, Opera, Vivaldi (unzip, then Load unpacked)
#   RedditSaver-chrome.zip   same files, named for Chrome users
#   RedditSaver-edge.zip     same files, named for Edge users
#   RedditSaver-firefox.zip  Firefox package (Firefox manifest, files at the root)
set -euo pipefail
cd "$(dirname "$0")"
FILES="background.js hostmap.js site.js results.html results.css results.js streams.js mp4.js zip.js lib-mux-mp4.js LICENSE-mux.js.txt icons"
OUT=dist; TMP=$(mktemp -d)
mkdir -p "$OUT"
rm -f "$OUT"/RedditSaver*.zip

mkdir "$TMP/reddit-saver"
cp -r $FILES manifest.json "$TMP/reddit-saver/"
(cd "$TMP" && zip -qr -X pkg.zip reddit-saver)
for n in RedditSaver RedditSaver-chrome RedditSaver-edge; do cp "$TMP/pkg.zip" "$OUT/$n.zip"; done

mkdir "$TMP/ff"
cp -r $FILES "$TMP/ff/"
cp manifest.firefox.json "$TMP/ff/manifest.json"
(cd "$TMP/ff" && zip -qr -X ../ff.zip .)
cp "$TMP/ff.zip" "$OUT/RedditSaver-firefox.zip"

rm -r "$TMP"
ls -l "$OUT"
