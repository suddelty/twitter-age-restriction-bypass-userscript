// ==UserScript==
// @name         Twitter Age Restriction Bypass
// @namespace    http://tampermonkey.net/
// @version      1.0
// @author       suddelty
// @description  Shows hidden/restricted media on Twitter/X by fetching it via the fxtwitter API.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.fxtwitter.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://api.fxtwitter.com';
    const processed = new WeakSet();
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

    function getStatusFromArticle(article) {
        const timeEl = article.querySelector('time');
        if (timeEl) {
            const a = timeEl.closest('a[href*="/status/"]');
            if (a) {
                const m = a.getAttribute('href').match(/\/([^\/]+)\/status\/(\d+)/);
                if (m) return { username: m[1], statusId: m[2] };
            }
        }
        for (const a of article.querySelectorAll('a[href*="/status/"]')) {
            const href = a.getAttribute('href');
            if (href.includes('/photo/') || href.includes('/video/')) continue;
            const m = href.match(/\/([^\/]+)\/status\/(\d+)/);
            if (m && m[1] !== 'i') return { username: m[1], statusId: m[2] };
        }
        return getStatusFromUrl();
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

    function findInterstitial(article) {
        // holy fuck this is a mess
        const exact = article.querySelector(
            'div.css-175oi2r.r-1p0dtai.r-eqz5dr.r-16y2uox.r-1777fci.r-1d2f490.r-1mmae3n.r-3pj75a.r-u8s1d.r-zchlnj.r-ipm5af.r-1867qdf'
        );
        if (exact) return exact;

        for (const testid of [
            'tweet-media-interstitial',
            'sensitiveMediaWarning',
            'previewInterstitial'
        ]) {
            const el = article.querySelector(`[data-testid="${testid}"]`);
            if (el) return el;
        }

        return null;
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

    function injectMedia(target, tweet) {
        const media = tweet.media;
        if (!media) return;

        const container = document.createElement('div');
        container.className = 'fxt-media';
        Object.assign(container.style, {
            width: '100%', borderRadius: '16px', overflow: 'hidden',
            margin: '0'
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
                    maxHeight: count === 1 ? '600px' : '300px'
                });
                img.loading = 'lazy';
                if (photo.altText) img.alt = photo.altText;

                a.appendChild(img);
                wrapper.appendChild(a);
                badge(wrapper);
                grid.appendChild(wrapper);
            });
            container.appendChild(grid);
        }

        videos.forEach(media => {
            const isGif = media.type === 'gif';
            const vidWrap = document.createElement('div');
            Object.assign(vidWrap.style, {
                position: 'relative', background: '#000',
                borderRadius: '16px', overflow: 'hidden'
            });

            const vid = document.createElement('video');
            vid.controls = true;
            vid.loop = true;
            vid.muted = true; // has to be muted so it can autoplay
            vid.autoplay = true;
            vid.playsInline = true;
            Object.assign(vid.style, {
                width: '100%', maxHeight: '600px', display: 'block'
            });
            if (media.thumbnail_url) vid.poster = media.thumbnail_url;

            const source = document.createElement('source');
            source.src = media.url;
            source.type = 'video/mp4';
            vid.appendChild(source);

            vidWrap.appendChild(vid);
            badge(vidWrap);
            container.appendChild(vidWrap);
        });

        if (container.children.length === 0) return;

        target.innerHTML = '';
        target.appendChild(container);
    }

    function rebuildRestrictedTweet(article, tweet) {
        const wrapper = document.createElement('div');
        wrapper.className = 'fxt-rebuilt';
        Object.assign(wrapper.style, {
            padding: '12px 16px', color: '#e7e9ea',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px'
        });

        if (tweet.author?.avatar_url) {
            const avatar = document.createElement('img');
            avatar.src = tweet.author.avatar_url;
            Object.assign(avatar.style, {
                width: '40px', height: '40px', borderRadius: '50%', flexShrink: '0'
            });
            header.appendChild(avatar);
        }

        const names = document.createElement('div');
        const displayName = document.createElement('a');
        displayName.href = `/${tweet.author?.screen_name || ''}`;
        displayName.textContent = tweet.author?.name || '';
        Object.assign(displayName.style, {
            color: '#e7e9ea', fontWeight: 'bold', fontSize: '15px',
            textDecoration: 'none', display: 'block'
        });
        const handle = document.createElement('a');
        handle.href = `/${tweet.author?.screen_name || ''}`;
        handle.textContent = `@${tweet.author?.screen_name || ''}`;
        Object.assign(handle.style, {
            color: '#71767b', fontSize: '14px', textDecoration: 'none'
        });
        names.appendChild(displayName);
        names.appendChild(handle);
        header.appendChild(names);
        wrapper.appendChild(header);

        if (tweet.text) {
            const textEl = document.createElement('div');
            textEl.textContent = tweet.text;
            Object.assign(textEl.style, {
                fontSize: '15px', lineHeight: '1.4', marginBottom: '10px',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            });
            wrapper.appendChild(textEl);
        }

        const mediaSlot = document.createElement('div');
        wrapper.appendChild(mediaSlot);

        if (tweet.created_at) {
            const timestamp = document.createElement('div');
            Object.assign(timestamp.style, {
                color: '#71767b', fontSize: '13px', marginTop: '10px'
            });
            timestamp.textContent = new Date(tweet.created_at).toLocaleString();
            wrapper.appendChild(timestamp);
        }

        article.innerHTML = '';
        article.appendChild(wrapper);

        injectMedia(mediaSlot, tweet);
    }

    function handleInterstitial(article, tweet) {
        const interstitial = findInterstitial(article);
        if (!interstitial || !interstitial.parentElement) return false;

        const parent = interstitial.parentElement;
        const thumbContainer = interstitial.previousElementSibling;

        const mediaSlot = document.createElement('div');
        Object.assign(mediaSlot.style, { width: '100%' });

        const insertBeforeNode = thumbContainer || interstitial;
        parent.insertBefore(mediaSlot, insertBeforeNode);

        if (thumbContainer) {
            thumbContainer.remove();
        }

        interstitial.remove();

        injectMedia(mediaSlot, tweet);
        return true;
    }

    async function processArticle(article) {
        if (processed.has(article)) return;
        processed.add(article);

        const interstitial = findInterstitial(article);
        if (!interstitial) return;

        const info = getStatusFromArticle(article);
        if (!info) return;

        const tweet = await fetchTweet(info.username, info.statusId);
        if (!tweet) return;

        handleInterstitial(article, tweet);
    }

    function enqueue(article) {
        if (processed.has(article)) return;
        queue.push(article);
        drain();
    }

    function drain() {
        while (queue.length && activeReqs < MAX_CONCURRENT) {
            const article = queue.shift();
            if (processed.has(article) || !document.contains(article)) continue;
            activeReqs++;
            processArticle(article).finally(() => {
                activeReqs--;
                setTimeout(drain, 250);
            });
        }
    }

    function scan() {
        document.querySelectorAll('article[data-testid="tweet"]').forEach(a => {
            if (!processed.has(a)) enqueue(a);
        });

        document.querySelectorAll('article:not([data-testid="tweet"])').forEach(a => {
            if (processed.has(a)) return;
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
        requestAnimationFrame(() => {
            scanPending = false;
            scan();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scan);
    } else {
        scan();
    }

    new MutationObserver(scheduleScan).observe(document.body, {
        childList: true, subtree: true
    });

    console.log('[Age Restriction Bypass] Active');
})();
