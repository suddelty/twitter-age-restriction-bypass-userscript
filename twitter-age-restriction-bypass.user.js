// ==UserScript==
// @name         Twitter Age Restriction Bypass
// @namespace    http://tampermonkey.net/
// @version      1.2
// @author       suddelty
// @description  Shows hidden/restricted media on Twitter/X by fetching it via the fxtwitter API.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.fxtwitter.com
// @run-at       document-idle
// @homepageURL  https://github.com/suddelty/twitter-age-restriction-bypass-userscript
// @updateURL   https://raw.githubusercontent.com/suddelty/twitter-age-restriction-bypass-userscript/main/twitter-age-restriction-bypass.user.js
// @downloadURL https://raw.githubusercontent.com/suddelty/twitter-age-restriction-bypass-userscript/main/twitter-age-restriction-bypass.user.js
// ==/UserScript==

(function () {
    'use strict';

    // config //

    // feel free to change these
    const AUTOPLAY = true; //enable/disable autoplaying videos
    const SHOW_BADGE = true; //enable/disable displaying the fxtwitter badge
    const QUOTE_NEW_TAB = true; //enable/disable opening quoted tweets in a new tab

    ////////////////////////////

    const API_BASE = 'https://api.fxtwitter.com';
    const cache = new Map();
    const failed = new Set();
    const queue = [];
    let activeReqs = 0;
    const MAX_CONCURRENT = 3;
    let scanPending = false;

    function getStatusFromUrl() {
        const m = location.pathname.match(/^\/([^\/]+)\/status\/(\d+)/);
        return m ? { username: m[1], statusId: m[2] } : null;
    }

    function parseStatusHref(href) {
        if (!href) return null;
        if (href.includes('/photo/') || href.includes('/video/')) return null;
        const m = href.match(/\/([^\/]+)\/status\/(\d+)/);
        if (!m) return null;
        return { username: m[1], statusId: m[2] };
    }

    function getStatusFromArticle(article) {
        const timeEl = article.querySelector('time');
        if (timeEl) {
            const a = timeEl.closest('a[href*="/status/"]');
            if (a) {
                const info = parseStatusHref(a.getAttribute('href'));
                if (info) return info;
            }
        }
        for (const a of article.querySelectorAll('a[href*="/status/"]')) {
            const info = parseStatusHref(a.getAttribute('href'));
            if (info) return info;
        }
        return getStatusFromUrl();
    }

    function getStatusFromInterstitial(interstitial, article) {
        const linkAncestor = interstitial.closest('a[href*="/status/"]');
        if (linkAncestor) {
            const info = parseStatusHref(linkAncestor.getAttribute('href'));
            if (info) return info;
        }

        const quoteContainer = interstitial.closest('div[role="link"]');
        if (quoteContainer && article.contains(quoteContainer)) {
            for (const a of quoteContainer.querySelectorAll('a[href*="/status/"]')) {
                const info = parseStatusHref(a.getAttribute('href'));
                if (info) return info;
            }
            const parentInfo = getStatusFromArticle(article);
            if (parentInfo) return { ...parentInfo, isQuote: true };
            return null;
        }

        const parentInfo = getStatusFromArticle(article);
        if (!parentInfo) return null;

        const thumb = interstitial.previousElementSibling;
        const thumbBg = thumb?.querySelector('[style*="background-image"]')
            ?.style?.backgroundImage || '';
        const thumbImgSrc = thumb?.querySelector('img')?.src || '';
        const mediaIdMatch = (thumbBg + ' ' + thumbImgSrc).match(/\/media\/([A-Za-z0-9_-]+)/);
        const thumbMediaId = mediaIdMatch ? mediaIdMatch[1] : null;

        return { ...parentInfo, isQuote: false, thumbMediaId };
    }

    function fetchTweet(username, statusId) {
        const key = `${username}/${statusId}`;
        if (cache.has(key)) return Promise.resolve(cache.get(key));
        if (failed.has(key)) return Promise.resolve(null);

        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${API_BASE}/${username}/status/${statusId}`,
                timeout: 12000,
                onload(r) {
                    try {
                        const data = JSON.parse(r.responseText);
                        if (data?.code === 200 && data?.tweet) {
                            cache.set(key, data.tweet);
                            resolve(data.tweet);
                        } else {
                            failed.add(key);
                            resolve(null);
                        }
                    } catch {
                        failed.add(key);
                        resolve(null);
                    }
                },
                onerror() { failed.add(key); resolve(null); },
                ontimeout() { failed.add(key); resolve(null); }
            });
        });
    }

    function findAllInterstitials(article) {
        // holy fuck this is a mess
        const exact = article.querySelectorAll(
            'div.css-175oi2r.r-1p0dtai.r-eqz5dr.r-16y2uox.r-1777fci.r-1d2f490.r-1mmae3n.r-3pj75a.r-u8s1d.r-zchlnj.r-ipm5af.r-1867qdf'
        );
        if (exact.length) return Array.from(exact);

        const results = [];
        for (const testid of [
            'tweet-media-interstitial',
            'sensitiveMediaWarning',
            'previewInterstitial'
        ]) {
            article.querySelectorAll(`[data-testid="${testid}"]`).forEach(el => results.push(el));
        }
        return results;
    }

    function badge(container) {
        if (container.querySelector('.fxt-badge')) return;
        const el = document.createElement('div');
        el.className = 'fxt-badge';
        el.textContent = 'fxtwitter';
        Object.assign(el.style, {
            position: 'absolute', top: '6px', left: '6px',
            background: 'rgba(0,0,0,.7)', color: '#4ade80',
            font: 'bold 10px/1 monospace', padding: '3px 6px',
            borderRadius: '4px', zIndex: '100', pointerEvents: 'none'
        });
        container.style.position = 'relative';
        container.appendChild(el);
    }

    function injectMedia(target, tweet, opts = {}) {
        const media = tweet.media;
        if (!media) return;

        const container = document.createElement('div');
        container.className = 'fxt-media';
        Object.assign(container.style, {
            width: '100%', borderRadius: '16px', overflow: 'hidden', margin: '0'
        });

        const photos = media.photos || [];
        const videos = (media.all || []).filter(m => m.type === 'video' || m.type === 'gif');

        if (photos.length > 0) {
            const grid = document.createElement('div');
            const count = photos.length;
            Object.assign(grid.style, {
                display: 'grid',
                gridTemplateColumns: count >= 2 ? '1fr 1fr' : '1fr',
                gap: '2px', borderRadius: '16px', overflow: 'hidden'
            });

            photos.forEach((photo, i) => {
                const wrapper = document.createElement('div');
                Object.assign(wrapper.style, {
                    position: 'relative', overflow: 'hidden', background: '#1a1a2e',
                    gridRow: (count === 3 && i === 0) ? 'span 2' : 'auto'
                });

                const a = document.createElement('a');
                a.href = photo.url;
                a.target = '_blank';

                const img = document.createElement('img');
                img.src = photo.url;
                Object.assign(img.style, {
                    width: '100%', height: '100%',
                    objectFit: 'cover', display: 'block',
                    minHeight: count > 1 ? '140px' : 'auto',
                    maxHeight: opts.fullSize ? 'none' : (count === 1 ? '600px' : '300px')
                });
                img.loading = 'lazy';
                if (photo.altText) img.alt = photo.altText;

                a.appendChild(img);
                wrapper.appendChild(a);
                if (SHOW_BADGE) badge(wrapper);
                grid.appendChild(wrapper);
            });
            container.appendChild(grid);
        }

        videos.forEach(media => {
            const vidWrap = document.createElement('div');
            Object.assign(vidWrap.style, {
                position: 'relative', background: '#000',
                borderRadius: '16px', overflow: 'hidden'
            });

            const vid = document.createElement('video');
            vid.controls = true;
            vid.loop = true;
            vid.muted = AUTOPLAY; // has to be muted so it can autoplay
            vid.autoplay = AUTOPLAY;
            vid.playsInline = true;
            Object.assign(vid.style, {
                width: '100%', maxHeight: opts.fullSize ? 'none' : '600px', display: 'block', cursor: 'default'
            });
            if (media.thumbnail_url) vid.poster = media.thumbnail_url;

            const source = document.createElement('source');
            source.src = media.url;
            source.type = 'video/mp4';
            vid.appendChild(source);

            vidWrap.appendChild(vid);
            if (SHOW_BADGE) badge(vidWrap);
            container.appendChild(vidWrap);
        });

        if (container.children.length === 0) return;

        target.innerHTML = '';
        target.appendChild(container);
    }

    function handleInterstitial(interstitial, tweet) {
        if (!interstitial?.parentElement) return false;

        const parent = interstitial.parentElement;
        const thumbContainer = interstitial.previousElementSibling;

        const mediaSlot = document.createElement('div');
        Object.assign(mediaSlot.style, { width: '100%' });

        const insertBeforeNode = thumbContainer || interstitial;
        parent.insertBefore(mediaSlot, insertBeforeNode);

        if (thumbContainer) thumbContainer.remove();
        interstitial.remove();

        injectMedia(mediaSlot, tweet, { fullSize: true });
        return true;
    }

    function handleQuoteInterstitial(interstitial, quotedTweet) {
        if (!interstitial?.parentElement) return false;

        let cardRoot = interstitial.closest('div[role="link"]');
        if (!cardRoot) {
            cardRoot = interstitial.parentElement?.parentElement;
        }
        if (!cardRoot) return false;

        const author = quotedTweet.author || {};
        const screenName = author.screen_name || author.username || '';
        const displayName = author.name || screenName;
        const tweetUrl = screenName
            ? `https://x.com/${screenName}/status/${quotedTweet.id || ''}`
            : null;

        const card = document.createElement('div');
        card.className = 'fxt-quote-card';
        Object.assign(card.style, {
            border: '1px solid rgb(47,51,54)',
            borderRadius: '12px',
            overflow: 'hidden',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            color: '#e7e9ea',
            background: '#000',
            cursor: tweetUrl ? 'pointer' : 'default',
        });
        if (tweetUrl) {
            card.addEventListener('click', e => {
                if (!e.target.closest('a, button, video')) {
                    if (QUOTE_NEW_TAB) {
                        window.open(tweetUrl, '_blank');
                    } else {
                        location.href = tweetUrl;
                    }
                }
            });
        }

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '10px 12px 0',
        });

        if (author.avatar_url) {
            const av = document.createElement('img');
            av.src = author.avatar_url;
            Object.assign(av.style, {
                width: '18px', height: '18px', borderRadius: '50%', flexShrink: '0',
            });
            header.appendChild(av);
        }

        const nameWrap = document.createElement('div');
        Object.assign(nameWrap.style, {
            display: 'flex', alignItems: 'baseline', gap: '4px', minWidth: 0,
        });

        const nameEl = document.createElement('a');
        nameEl.href = screenName ? `https://x.com/${screenName}` : '#';
        nameEl.textContent = displayName;
        Object.assign(nameEl.style, {
            fontWeight: '700', fontSize: '14px', color: '#e7e9ea',
            textDecoration: 'none', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
        });
        nameEl.addEventListener('click', e => e.stopPropagation());

        const handleEl = document.createElement('a');
        handleEl.href = screenName ? `https://x.com/${screenName}` : '#';
        handleEl.textContent = `@${screenName}`;
        Object.assign(handleEl.style, {
            fontSize: '13px', color: '#71767b',
            textDecoration: 'none', whiteSpace: 'nowrap',
        });
        handleEl.addEventListener('click', e => e.stopPropagation());

        nameWrap.appendChild(nameEl);
        nameWrap.appendChild(handleEl);
        header.appendChild(nameWrap);
        card.appendChild(header);

        if (quotedTweet.text) {
            const textEl = document.createElement('div');
            textEl.textContent = quotedTweet.text;
            Object.assign(textEl.style, {
                fontSize: '14px', lineHeight: '1.4', padding: '4px 12px 8px',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e7e9ea',
            });
            card.appendChild(textEl);
        }

        if (quotedTweet.created_at) {
            const ts = document.createElement('div');
            ts.textContent = new Date(quotedTweet.created_at).toLocaleString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit',
            });
            Object.assign(ts.style, {
                fontSize: '13px', color: '#71767b',
                padding: '2px 12px 8px',
            });
            card.appendChild(ts);
        }

        const mediaSlot = document.createElement('div');
        card.appendChild(mediaSlot);
        injectMedia(mediaSlot, quotedTweet, { fullSize: true });

        cardRoot.replaceWith(card);
        return true;
    }

    function extractQuoteTweet(tweet) {
        return tweet.quote ?? tweet.quote_tweet ?? tweet.quoted_tweet ?? tweet.quotedTweet ?? null;
    }

    function tweetHasMediaId(tweet, mediaId) {
        if (!mediaId || !tweet?.media) return false;
        const all = [
            ...(tweet.media.photos || []).map(p => p.url),
            ...(tweet.media.all || []).map(m => m.url),
            ...(tweet.media.all || []).map(m => m.thumbnail_url).filter(Boolean),
        ];
        return all.some(url => url && url.includes(mediaId));
    }

    async function processArticle(article) {
        const interstitials = findAllInterstitials(article);
        if (!interstitials.length) return;

        for (const interstitial of interstitials) {
            if (!document.contains(interstitial)) continue;

            const info = getStatusFromInterstitial(interstitial, article);
            if (!info) continue;

            let tweet = await fetchTweet(info.username, info.statusId);
            if (!tweet) continue;

            const quotedTweet = extractQuoteTweet(tweet);
            let isQuoteTweet = false;

            if (info.isQuote) {
                if (!quotedTweet) continue;
                tweet = quotedTweet;
                isQuoteTweet = true;
            } else if (quotedTweet) {
                const { thumbMediaId } = info;
                const parentHasIt = tweetHasMediaId(tweet, thumbMediaId);
                const quoteHasIt = tweetHasMediaId(quotedTweet, thumbMediaId);

                if (quoteHasIt || (!parentHasIt && !tweet.media)) {
                    tweet = quotedTweet;
                    isQuoteTweet = true;
                }
            }

            if (!tweet.media) continue;

            if (isQuoteTweet) {
                handleQuoteInterstitial(interstitial, tweet);
            } else {
                handleInterstitial(interstitial, tweet);
            }
        }
    }

    function enqueue(article) {
        if (findAllInterstitials(article).length === 0) return;
        queue.push(article);
        drain();
    }

    function drain() {
        while (queue.length && activeReqs < MAX_CONCURRENT) {
            const article = queue.shift();
            if (!document.contains(article)) continue;
            activeReqs++;
            processArticle(article).finally(() => {
                activeReqs--;
                setTimeout(drain, 250);
            });
        }
    }

    function scan() {
        document.querySelectorAll('article[data-testid="tweet"]').forEach(a => enqueue(a));

        document.querySelectorAll('article:not([data-testid="tweet"])').forEach(a => {
            const text = a.textContent || '';
            if (text.includes('Age-restricted') || text.includes('sensitive') ||
                text.includes('unavailable') || text.includes('Caution') ||
                text.includes('log in')) {
                enqueue(a);
            }
        });
    }

    function scheduleScan() {
        if (scanPending) return;
        scanPending = true;
        requestAnimationFrame(() => { scanPending = false; scan(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scan);
    } else {
        scan();
    }

    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });

    console.log('[Age Restriction Bypass] Active');
})();