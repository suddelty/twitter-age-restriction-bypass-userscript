# Twitter Age Restriction Bypass Userscript

Tampermonkey userscript that reveals hidden or age-restricted media on Twitter by fetching it through the [fxtwitter](https://fxtwitter.com) API. When you encounter a tweet with blurred or blocked images/videos, the script automatically replaces the interstitial with the actual media.

## Requirements

- A userscript manager: [Tampermonkey](https://www.tampermonkey.net/)

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the raw script URL: [twitter-age-restriction-bypass.user.js](https://raw.githubusercontent.com/suddelty/twitter-age-restriction-bypass-userscript/main/twitter-age-restriction-bypass.user.js)
3. Tampermonkey will detect the userscript and prompt you to install it. Click **Install**.

## Usage

No configuration needed. Once installed, the script runs automatically:

- Browse Twitter as usual.
- When you see a tweet with age-restricted or sensitive media (blurred preview, "Caution" warning, etc.), the script fetches the media via fxtwitter and replaces the placeholder.
- Unblocked media shows a small **fxtwitter** badge in the corner.

The script processes tweets in the feed as you scroll and keeps a cache to avoid repeated API calls.
