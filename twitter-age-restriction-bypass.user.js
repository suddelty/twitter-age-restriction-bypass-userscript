// ==UserScript==
// @name         Twitter Age Restriction Bypass
// @namespace    http://tampermonkey.net/
// @version      1.3
// @author       suddelty
// @description  Shows hidden/restricted media on Twitter/X by fetching it via the fxtwitter API.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
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
    const MAX_QUOTE_DEPTH = 4;
    const cache = new Map();
    const failed = new Set();
    const inFlight = new Map();
    const processed = new WeakSet();
    const queue = [];
    let activeReqs = 0;
    const MAX_CONCURRENT = 3;
    let scanPending = false;

    const GATE_RE = /sensitive content|age[\s-]?restricted|only available in the x app|potentially sensitive|the following media includes|content warning|this media may contain|verify your age/i;
    const GATE_NOISE_RE = /scan to get app|log in|sign up|continue with|get the app|qr code/ig;

    function gmXhr() {
        if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
        if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest;
        return null;
    }

    function css(node, styles) {
        Object.assign(node.style, styles);
        return node;
    }

    function h(tag, styles, props) {
        const el = document.createElement(tag);
        if (styles) css(el, styles);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (k === 'text') el.textContent = v;
                else if (k === 'html') el.innerHTML = v;
                else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
                else if (v != null) el.setAttribute(k, v);
            }
        }
        return el;
    }

    function theme() {
        const root = document.documentElement;
        const explicit = root.getAttribute('data-theme');
        const dark = explicit === 'dark'
            || (explicit !== 'light' && (
                window.matchMedia('(prefers-color-scheme: dark)').matches
                || luminance(getComputedStyle(document.body).backgroundColor) < 80
            ));
        return dark ? {
            text: '#e7e9ea',
            muted: '#71767b',
            border: 'rgb(47, 51, 54)',
            bg: 'transparent',
            card: '#000',
            media: '#0f0f0f',
            hover: 'rgba(255,255,255,0.03)',
        } : {
            text: '#0f1419',
            muted: '#536471',
            border: '#cfd9de',
            bg: 'transparent',
            card: '#fff',
            media: '#eff3f4',
            hover: 'rgba(0,0,0,0.03)',
        };
    }

    function luminance(rgb) {
        const m = String(rgb).match(/(\d+)/g);
        if (!m || m.length < 3) return 0;
        return (Number(m[0]) * 299 + Number(m[1]) * 587 + Number(m[2]) * 114) / 1000;
    }

    function parseStatusHref(href) {
        if (!href) return null;
        const m = String(href).match(/\/([^\/?#]+)\/status\/(\d+)/);
        if (!m) return null;
        return { username: m[1], statusId: m[2] };
    }

    function getStatusFromUrl() {
        const path = location.pathname;
        let m = path.match(/^\/i\/(?:web\/)?status\/(\d+)/);
        if (m) return { username: 'i', statusId: m[1] };
        m = path.match(/^\/([^\/]+)\/status\/(\d+)/);
        if (m) return { username: m[1], statusId: m[2] };
        return null;
    }

    function getConversationStatusId() {
        const el = document.querySelector('[id^="urt:conversation:"]');
        const m = el?.id?.match(/urt:conversation:(\d+)/);
        return m ? m[1] : null;
    }

    function resolveStatus(fromEl) {
        if (!fromEl) return getStatusFromUrl();

        const dataHrefEl = fromEl.closest('[data-href*="/status/"]') || fromEl.querySelector?.('[data-href*="/status/"]');
        const fromData = parseStatusHref(dataHrefEl?.getAttribute('data-href'));
        if (fromData) return fromData;

        const timeLink = fromEl.querySelector?.('time')?.closest('a[href*="/status/"]');
        const fromTime = parseStatusHref(timeLink?.getAttribute('href'));
        if (fromTime) return fromTime;

        const links = fromEl.querySelectorAll?.('a[href*="/status/"]') || [];
        for (const a of links) {
            const href = a.getAttribute('href') || '';
            if (href.includes('/photo/') || href.includes('/video/')) continue;
            const info = parseStatusHref(href);
            if (info) return info;
        }

        const convId = getConversationStatusId();
        const urlInfo = getStatusFromUrl();
        if (urlInfo) return urlInfo;
        if (convId) return { username: 'i', statusId: convId };
        return null;
    }

    function extractQuote(tweet) {
        return tweet?.quote ?? tweet?.quote_tweet ?? tweet?.quoted_tweet ?? tweet?.quotedTweet ?? null;
    }

    function isTombstone(quote) {
        return !quote || quote.type === 'tombstone';
    }

    function tweetUrl(tweet) {
        const author = tweet?.author || {};
        const screen = author.screen_name || author.username || '';
        if (screen && tweet.id) return `https://x.com/${screen}/status/${tweet.id}`;
        return tweet?.url || null;
    }

    function getMediaItems(tweet) {
        const media = tweet?.media;
        if (!media) return [];
        if (Array.isArray(media.all) && media.all.length) return media.all;
        return [...(media.photos || []), ...(media.videos || [])];
    }

    function tweetHasRenderableContent(tweet) {
        if (!tweet) return false;
        if (getMediaItems(tweet).length) return true;
        const quote = extractQuote(tweet);
        if (quote && !isTombstone(quote)) return true;
        if ((tweet.text || '').trim()) return true;
        return false;
    }

    function fetchTweet(username, statusId) {
        const key = `${username || 'i'}/${statusId}`;
        if (cache.has(key)) return Promise.resolve(cache.get(key));
        if (failed.has(key)) return Promise.resolve(null);
        if (inFlight.has(key)) return inFlight.get(key);

        const req = new Promise((resolve) => {
            const xhr = gmXhr();
            if (!xhr) {
                failed.add(key);
                resolve(null);
                return;
            }
            xhr({
                method: 'GET',
                url: `${API_BASE}/${username || 'i'}/status/${statusId}`,
                timeout: 15000,
                onload(r) {
                    try {
                        const data = JSON.parse(r.responseText);
                        const tweet = data?.tweet || data?.status;
                        if ((data?.code === 200 || tweet) && tweet) {
                            cache.set(key, tweet);
                            if (tweet.id) cache.set(`i/${tweet.id}`, tweet);
                            resolve(tweet);
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

        inFlight.set(key, req);
        req.finally(() => inFlight.delete(key));
        return req;
    }

    function badge(container) {
        if (!SHOW_BADGE || container.querySelector('.fxt-badge')) return;
        const el = h('div', {
            position: 'absolute', top: '6px', left: '6px',
            background: 'rgba(0,0,0,.7)', color: '#4ade80',
            font: 'bold 10px/1 monospace', padding: '3px 6px',
            borderRadius: '4px', zIndex: '100', pointerEvents: 'none'
        }, { class: 'fxt-badge', text: 'fxtwitter' });
        container.style.position = container.style.position || 'relative';
        container.appendChild(el);
    }

    function fillWidth(el) {
        return css(el, {
            width: '100%',
            maxWidth: '100%',
            minWidth: '0',
            boxSizing: 'border-box',
            alignSelf: 'stretch'
        });
    }

    function clampAspect(width, height, fallback = 16 / 9) {
        const ar = (width > 0 && height > 0) ? (width / height) : fallback;
        return Math.min(1.91, Math.max(0.75, ar));
    }

    function photoLayout(count) {
        if (count <= 1) return { columns: '1fr', rows: 'auto', aspect: null };
        if (count === 2) return { columns: '1fr 1fr', rows: '1fr', aspect: '1.6 / 1' };
        if (count === 3) return { columns: '1fr 1fr', rows: '1fr 1fr', aspect: '1.35 / 1' };
        return { columns: '1fr 1fr', rows: '1fr 1fr', aspect: '1 / 1' };
    }

    function renderPhoto(photo, count, t) {
        const wrapper = h('div', {
            position: 'relative', overflow: 'hidden', background: t.media,
            width: '100%', minWidth: '0', minHeight: '0'
        });
        if (count === 1) {
            css(wrapper, { aspectRatio: String(clampAspect(photo.width, photo.height)) });
        } else {
            css(wrapper, { height: '100%' });
            if (count === 3 && photo._i === 0) css(wrapper, { gridRow: '1 / span 2' });
        }
        const a = h('a', {
            display: 'block', width: '100%', height: '100%'
        }, { href: photo.url, target: '_blank', rel: 'noreferrer' });
        const img = h('img', {
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center',
            display: 'block'
        });
        img.src = photo.url;
        img.loading = 'lazy';
        if (photo.altText) img.alt = photo.altText;
        a.appendChild(img);
        wrapper.appendChild(a);
        if (count === 1) badge(wrapper);
        return wrapper;
    }

    function renderVideo(media) {
        const vidWrap = h('div', {
            position: 'relative', background: '#000',
            overflow: 'hidden', width: '100%',
            aspectRatio: String(clampAspect(media.width, media.height, 16 / 9))
        });
        const vid = h('video', {
            width: '100%', height: '100%', display: 'block', cursor: 'default',
            objectFit: 'cover'
        });
        vid.controls = true;
        vid.loop = media.type === 'gif' || AUTOPLAY;
        vid.muted = media.type === 'gif' || AUTOPLAY;
        vid.autoplay = media.type === 'gif' || AUTOPLAY;
        vid.playsInline = true;
        vid.setAttribute('playsinline', '');
        if (media.thumbnail_url) vid.poster = media.thumbnail_url;
        const source = document.createElement('source');
        source.src = media.url;
        source.type = media.format || 'video/mp4';
        vid.appendChild(source);
        vidWrap.appendChild(vid);
        badge(vidWrap);
        return vidWrap;
    }

    function renderMedia(tweet) {
        const items = getMediaItems(tweet);
        if (!items.length) return null;
        const t = theme();
        const container = fillWidth(h('div', {
            width: '100%', overflow: 'hidden', margin: '0', borderRadius: '16px'
        }, { class: 'fxt-media' }));

        const photos = items
            .map((m, i) => ({ ...m, _i: i }))
            .filter(m => m.type === 'photo' || (!m.type && m.url && !/video\.twimg/.test(m.url || '')));
        const onlyPhotos = photos.length && photos.length === items.length;

        if (onlyPhotos) {
            const layout = photoLayout(photos.length);
            const grid = fillWidth(h('div', {
                display: 'grid',
                width: '100%',
                gridTemplateColumns: layout.columns,
                gridTemplateRows: layout.rows,
                gap: '2px',
                overflow: 'hidden',
                borderRadius: photos.length > 1 ? '16px' : undefined,
                aspectRatio: layout.aspect || undefined,
                minHeight: photos.length > 1 ? '280px' : undefined
            }, { class: 'fxt-media-grid' }));
            photos.slice(0, 4).forEach(photo => grid.appendChild(renderPhoto(photo, Math.min(photos.length, 4), t)));
            container.appendChild(grid);
            if (photos.length > 1) {
                css(container, { borderRadius: '16px', overflow: 'hidden' });
                badge(container);
            }
            return container;
        }

        items.forEach((item, i) => {
            if (item.type === 'video' || item.type === 'gif') {
                container.appendChild(renderVideo(item));
            } else {
                const single = renderPhoto({ ...item, _i: 0 }, 1, t);
                css(single, { marginBottom: i === items.length - 1 ? '0' : '2px' });
                container.appendChild(single);
            }
        });
        return container.children.length ? container : null;
    }

    function formatTime(createdAt) {
        if (!createdAt) return '';
        const d = new Date(createdAt);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit',
        });
    }

    function formatCount(n) {
        if (n == null) return '';
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
        return String(n);
    }

    function stopCardNav(e) {
        if (e.target.closest('a, button, video, img')) e.stopPropagation();
    }

    function renderQuoteCard(quotedTweet, depth) {
        const t = theme();
        if (isTombstone(quotedTweet)) {
            const dead = fillWidth(h('div', {
                border: `1px solid ${t.border}`,
                borderRadius: '16px',
                padding: '12px 16px',
                color: t.muted,
                fontSize: '15px',
            }, { class: 'fxt-quote-card', text: quotedTweet?.reason === 'deleted'
                ? 'This post was deleted.'
                : 'This post is unavailable.' }));
            return dead;
        }

        const author = quotedTweet.author || {};
        const screenName = author.screen_name || author.username || '';
        const displayName = author.name || screenName;
        const url = tweetUrl(quotedTweet);

        const card = fillWidth(h('div', {
            border: `1px solid ${t.border}`,
            borderRadius: '16px',
            overflow: 'hidden',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            color: t.text,
            background: t.card,
            cursor: url ? 'pointer' : 'default',
        }, { class: 'fxt-quote-card' }));

        if (url) {
            card.addEventListener('click', e => {
                if (e.target.closest('a, button, video')) return;
                if (QUOTE_NEW_TAB) window.open(url, '_blank', 'noopener');
                else location.href = url;
            });
        }

        const inner = h('div', { padding: '12px 12px 8px' });
        const header = h('div', {
            display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0
        });

        if (author.avatar_url) {
            const av = h('img', {
                width: '20px', height: '20px', borderRadius: '50%', flexShrink: '0'
            });
            av.src = author.avatar_url;
            header.appendChild(av);
        }

        const nameEl = h('a', {
            fontWeight: '700', fontSize: '14px', color: t.text,
            textDecoration: 'none', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
        }, {
            href: screenName ? `https://x.com/${screenName}` : '#',
            text: displayName
        });
        nameEl.addEventListener('click', e => e.stopPropagation());

        const handleEl = h('a', {
            fontSize: '14px', color: t.muted,
            textDecoration: 'none', whiteSpace: 'nowrap',
        }, {
            href: screenName ? `https://x.com/${screenName}` : '#',
            text: screenName ? `@${screenName}` : ''
        });
        handleEl.addEventListener('click', e => e.stopPropagation());

        header.appendChild(nameEl);
        header.appendChild(handleEl);
        inner.appendChild(header);

        if (quotedTweet.text) {
            inner.appendChild(h('div', {
                fontSize: '15px', lineHeight: '1.4', padding: '6px 0 4px',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: t.text,
            }, { text: quotedTweet.text }));
        }
        card.appendChild(inner);

        const media = renderMedia(quotedTweet);
        if (media) card.appendChild(media);

        const nested = extractQuote(quotedTweet);
        if (nested && depth < MAX_QUOTE_DEPTH) {
            const nestedWrap = fillWidth(h('div', { padding: '0 12px 12px' }));
            nestedWrap.appendChild(renderQuoteCard(nested, depth + 1));
            card.appendChild(nestedWrap);
        }

        card.addEventListener('click', stopCardNav);
        return card;
    }

    function renderFullTweet(tweet) {
        const t = theme();
        const author = tweet.author || {};
        const screenName = author.screen_name || author.username || '';
        const displayName = author.name || screenName;
        const url = tweetUrl(tweet);

        const card = fillWidth(h('div', {
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            color: t.text,
            background: t.bg,
            padding: '4px 0 8px',
        }, { class: 'fxt-tweet' }));

        const header = h('div', {
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '4px 0 8px'
        });

        if (author.avatar_url) {
            const avLink = h('a', null, {
                href: screenName ? `https://x.com/${screenName}` : '#',
                target: '_blank', rel: 'noreferrer'
            });
            const av = h('img', {
                width: '40px', height: '40px', borderRadius: '50%', flexShrink: '0'
            });
            av.src = author.avatar_url;
            avLink.appendChild(av);
            header.appendChild(avLink);
        }

        const names = h('div', { display: 'flex', flexDirection: 'column', minWidth: 0 });
        const nameEl = h('a', {
            fontWeight: '700', fontSize: '15px', color: t.text,
            textDecoration: 'none', lineHeight: '1.2'
        }, {
            href: screenName ? `https://x.com/${screenName}` : '#',
            text: displayName
        });
        const handleEl = h('a', {
            fontSize: '15px', color: t.muted, textDecoration: 'none'
        }, {
            href: screenName ? `https://x.com/${screenName}` : '#',
            text: screenName ? `@${screenName}` : ''
        });
        names.appendChild(nameEl);
        names.appendChild(handleEl);
        header.appendChild(names);
        card.appendChild(header);

        if (tweet.text) {
            card.appendChild(h('div', {
                fontSize: '17px', lineHeight: '1.4', padding: '4px 0 12px',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: t.text,
            }, { text: tweet.text }));
        }

        const media = renderMedia(tweet);
        if (media) {
            css(media, { marginBottom: '12px' });
            card.appendChild(media);
        }

        const quote = extractQuote(tweet);
        if (quote) {
            const wrap = fillWidth(h('div', { margin: '0 0 12px' }));
            wrap.appendChild(renderQuoteCard(quote, 1));
            card.appendChild(wrap);
        }

        const meta = h('div', {
            display: 'flex', flexWrap: 'wrap', gap: '6px',
            fontSize: '15px', color: t.muted, padding: '4px 0'
        });
        const when = formatTime(tweet.created_at);
        if (when) {
            const timeEl = url
                ? h('a', { color: t.muted, textDecoration: 'none' }, { href: url, text: when })
                : h('span', null, { text: when });
            meta.appendChild(timeEl);
        }
        const bits = [
            tweet.replies != null ? `${formatCount(tweet.replies)} Replies` : null,
            tweet.retweets != null ? `${formatCount(tweet.retweets)} Reposts` : null,
            tweet.likes != null ? `${formatCount(tweet.likes)} Likes` : null,
            tweet.views != null ? `${formatCount(tweet.views)} Views` : null,
        ].filter(Boolean);
        if (bits.length) {
            if (when) meta.appendChild(h('span', null, { text: '·' }));
            meta.appendChild(h('span', null, { text: bits.join(' · ') }));
        }
        if (meta.childNodes.length) card.appendChild(meta);

        return card;
    }

    function markProcessed(el) {
        if (!el) return;
        processed.add(el);
        el.classList.add('fxt-done');
        el.setAttribute('data-fxt', '1');
    }

    function alreadyProcessed(el) {
        return !el || processed.has(el) || el.closest?.('.fxt-tweet, .fxt-quote-card, .fxt-media, .fxt-done');
    }

    function tweetColumnWidth(article) {
        const ar = article.getBoundingClientRect();
        if (ar.width < 80) return 0;
        const expectedMin = ar.width - 96;
        const expectedMax = ar.width - 24;
        const av = [...article.querySelectorAll('img')].find(img => {
            const r = img.getBoundingClientRect();
            return r.width >= 20 && r.width <= 48 && r.height >= 20 && r.height <= 48
                && r.left <= ar.left + 56;
        });
        let best = 0;
        const seed = article.querySelector('time') || article.querySelector('a[href*="/status/"]');
        let el = seed ? seed.parentElement : article.firstElementChild;
        while (el && el !== article) {
            const r = el.getBoundingClientRect();
            if (r.width >= expectedMin && r.width <= expectedMax && !(av && el.contains(av))) {
                best = r.width;
                break;
            }
            el = el.parentElement;
        }
        return best || Math.max(200, ar.width - 80);
    }

    function findTweetColumn(article) {
        const colW = tweetColumnWidth(article);
        if (colW < 40) return null;
        const seed = article.querySelector('time') || article.querySelector('a[href*="/status/"]');
        let el = seed ? seed.parentElement : null;
        while (el && el !== article) {
            const w = el.getBoundingClientRect().width;
            if (Math.abs(w - colW) <= 12 && el.querySelector('time')) return el;
            el = el.parentElement;
        }
        return null;
    }

    function findMediaSlot(gateEl, article) {
        if (!gateEl || !article) return null;
        const colW = tweetColumnWidth(article);
        if (colW < 40) return findCardShell(gateEl, article);
        let el = gateEl;
        while (el && el !== article) {
            const w = el.getBoundingClientRect().width;
            if (w >= 40 && Math.abs(w - colW) <= 12 && !el.querySelector('time')) return el;
            el = el.parentElement;
        }
        const col = findTweetColumn(article);
        let columnChild = null;
        if (col && col.contains(gateEl)) {
            let child = gateEl;
            while (child && child !== col) {
                columnChild = child;
                child = child.parentElement;
            }
        }
        const safeChild = columnChild
            && columnChild !== gateEl
            && !columnChild.querySelector('time')
            && !columnChild.querySelector('[data-testid="reply"], [data-testid="like"], [data-testid="retweet"], [data-testid="bookmark"]');
        if (safeChild) return columnChild;
        const shell = findCardShell(gateEl, article);
        if (shell && !shell.querySelector('time') && shell.getBoundingClientRect().width >= colW * 0.9) return shell;
        return shell && !shell.querySelector('time') ? shell : null;
    }

    function isQuoteCardEl(el, article) {
        if (!el || !article || !article.contains(el) || el.contains(article)) return false;
        if (el === article || el.getAttribute?.('role') === 'article') return false;
        const cls = String(el.className || '');
        if (/rounded-2xl|rounded-xl|rounded-md/.test(cls) && /border|overflow-hidden/.test(cls)) return true;

        const st = window.getComputedStyle(el);
        const radius = parseFloat(st.borderRadius) || 0;
        if (radius < 12) return false;
        const ar = article.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        if (er.width < 160 || ar.width < 160) return false;
        const colW = tweetColumnWidth(article);
        return er.width >= Math.min(colW, ar.width) * 0.72 && er.width <= ar.width - 8;
    }

    function findCardShell(gateEl, article) {
        let el = gateEl;
        while (el && el !== article) {
            if (isQuoteCardEl(el, article)) return el;
            el = el.parentElement;
        }
        return null;
    }

    function isQuoteContext(gateEl) {
        const article = gateEl.closest('article');

        const hrefCard = gateEl.closest('[data-href*="/status/"][role="link"], [data-href*="/status/"][role="button"], a[href*="/status/"][role="link"]');
        if (hrefCard && article && article.contains(hrefCard) && !hrefCard.contains(article)) {
            return findMediaSlot(hrefCard, article) || hrefCard;
        }

        if (!article) return null;

        const clickable = gateEl.closest('[role="button"], [role="link"]');
        if (isQuoteCardEl(clickable, article)) return findMediaSlot(clickable, article) || clickable;

        const rounded = gateEl.closest('div[class*="rounded-2xl"], div[class*="rounded-xl"]');
        if (isQuoteCardEl(rounded, article)) return findMediaSlot(rounded, article) || rounded;

        const shell = findCardShell(gateEl, article);
        if (shell && /age[\s-]?restricted/i.test(`${shell.innerText || ''} ${gateEl.innerText || ''}`)) {
            return findMediaSlot(shell, article) || shell;
        }
        return null;
    }

    function hostLooksLikeFullGate(host) {
        if (!host) return true;
        if (host.querySelector('article') && host.querySelector('a[href^="/"]') && !GATE_RE.test((host.querySelector('article')?.innerText || '').slice(0, 80))) {
            return false;
        }
        const raw = (host.innerText || '').replace(GATE_NOISE_RE, '').replace(GATE_RE, '').trim();
        const hasAuthorLink = !!host.querySelector('a[href^="/"][href*="/status/"], a[href^="/"][aria-label]');
        return raw.length < 60 && !hasAuthorLink;
    }

    function findReplacementTarget(gateEl) {
        const quote = isQuoteContext(gateEl);
        if (quote) return { mode: 'quote', el: quote };

        const overlay = gateEl.closest('div.relative.overflow-hidden.rounded-2xl')
            || gateEl.closest('[class*="overflow-hidden"][class*="rounded"]')
            || gateEl.closest('[data-testid="tweet-media-interstitial"], [data-testid="sensitiveMediaWarning"], [data-testid="previewInterstitial"]');

        const article = gateEl.closest('article');
        const li = gateEl.closest('li');
        const slot = article ? findMediaSlot(gateEl, article) : null;
        const host = article || li || overlay || gateEl.parentElement;

        if (hostLooksLikeFullGate(host) || !article) {
            return { mode: 'full', el: overlay || host };
        }
        return { mode: 'media', el: slot || overlay || gateEl };
    }

    function collectGateElements() {
        const found = [];
        const seen = new Set();

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !GATE_RE.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        while (walker.nextNode()) {
            const parent = walker.currentNode.parentElement;
            if (!parent || alreadyProcessed(parent)) continue;
            if (parent.closest('script, style, noscript, .fxt-tweet, .fxt-quote-card')) continue;
            found.push(parent);
        }

        for (const testid of ['tweet-media-interstitial', 'sensitiveMediaWarning', 'previewInterstitial']) {
            document.querySelectorAll(`[data-testid="${testid}"]`).forEach(el => {
                if (!alreadyProcessed(el)) found.push(el);
            });
        }

        document.querySelectorAll('button, [role="button"]').forEach(btn => {
            if (alreadyProcessed(btn)) return;
            const label = (btn.textContent || '').replace(/\s+/g, ' ').trim();
            if (!/^Show$/i.test(label)) return;
            const article = btn.closest('article');
            if (article && GATE_RE.test(article.innerText || '')) found.push(btn);
        });

        const targets = [];
        for (const el of found) {
            const target = findReplacementTarget(el);
            if (!target?.el || alreadyProcessed(target.el) || seen.has(target.el)) continue;
            seen.add(target.el);
            targets.push({ gateEl: el, ...target });
        }
        return targets;
    }

    function scrubGateChrome(root) {
        if (!root || root.nodeType !== 1) return;
        root.querySelectorAll('button, [role="button"]').forEach(btn => {
            if (btn.closest('.fxt-tweet, .fxt-quote-card, .fxt-media')) return;
            const label = (btn.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^Show$/i.test(label)) btn.remove();
        });
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !GATE_RE.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
                if (node.parentElement?.closest('.fxt-tweet, .fxt-quote-card, .fxt-media')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const doomed = [];
        while (walker.nextNode()) {
            const el = walker.currentNode.parentElement;
            if (el) doomed.push(el);
        }
        for (const el of doomed) {
            const box = el.closest('div') || el;
            if (!box.closest('.fxt-tweet, .fxt-quote-card, .fxt-media')) {
                box.remove();
            }
        }
    }

    function swapContent(target, node) {
        if (!target?.parentElement && target !== document.body) return false;
        fillWidth(node);
        css(node, { borderRadius: node.classList?.contains('fxt-quote-card') ? node.style.borderRadius : '16px' });
        markProcessed(target);
        markProcessed(node);
        const article = target.closest?.('article') || target;
        const keepHost = target === document.body
            || target.tagName === 'ARTICLE'
            || target.tagName === 'LI'
            || target.getAttribute?.('role') === 'article'
            || target.getAttribute?.('data-testid') === 'cellInnerDiv';
        if (target.querySelector?.('time') && target.tagName !== 'ARTICLE' && target.getAttribute?.('role') !== 'article') {
            return false;
        }
        if (keepHost) {
            target.innerHTML = '';
            fillWidth(target);
            target.appendChild(node);
        } else {
            target.replaceWith(node);
        }
        scrubGateChrome(article);
        return true;
    }

    function handleMediaInterstitial(interstitial, tweet) {
        if (!interstitial?.parentElement) return false;
        const parent = interstitial.parentElement;
        const thumbContainer = interstitial.previousElementSibling;
        const mediaSlot = fillWidth(h('div', { width: '100%' }, { class: 'fxt-media-slot' }));
        const insertBeforeNode = thumbContainer || interstitial;
        parent.insertBefore(mediaSlot, insertBeforeNode);
        if (thumbContainer && thumbContainer !== interstitial) thumbContainer.remove();
        interstitial.remove();
        const media = renderMedia(tweet);
        if (media) mediaSlot.appendChild(media);
        markProcessed(mediaSlot);
        return true;
    }

    async function processTarget(target) {
        if (alreadyProcessed(target.el)) return;

        const article = target.el?.closest?.('article');
        if (article) {
            const colW = tweetColumnWidth(article);
            const slot = findMediaSlot(target.el, article) || target.el;
            const w = slot.getBoundingClientRect().width;
            const parentW = slot.parentElement?.getBoundingClientRect().width || 0;
            if (colW >= 40 && w < 40) return;
            if (colW >= 40 && w < colW * 0.85 && parentW < colW * 0.85) return;
        }

        let info = resolveStatus(target.el) || resolveStatus(target.gateEl);
        if (!info) info = resolveStatus(target.el?.closest?.('article') || document.body);
        if (!info) return;

        let tweet = await fetchTweet(info.username, info.statusId);
        if (!tweet) return;

        const quoted = extractQuote(tweet);
        const ownMedia = getMediaItems(tweet);
        const quoteInfo = parseStatusHref(target.el.getAttribute?.('data-href') || target.el.getAttribute?.('href'));

        let renderQuote = target.mode === 'quote';
        if (quoteInfo && quoteInfo.statusId !== info.statusId) renderQuote = true;
        if (!ownMedia.length && quoted && !isTombstone(quoted)) renderQuote = true;

        if (renderQuote) {
            let q = quoted && !isTombstone(quoted) ? quoted : null;
            if (quoteInfo) q = await fetchTweet(quoteInfo.username, quoteInfo.statusId) || q;
            if (!q && quoted && !isTombstone(quoted)) q = quoted;
            if (q && tweetHasRenderableContent(q)) {
                swapContent(target.el, renderQuoteCard(q, 1));
                return;
            }
        }

        if (!tweetHasRenderableContent(tweet)) return;

        if (target.mode === 'full') {
            swapContent(target.el, renderFullTweet(tweet));
            return;
        }
        const media = renderMedia(tweet);
        if (media) {
            const article = target.el?.closest?.('article');
            const slot = article ? findMediaSlot(target.el, article) : null;
            if (swapContent(slot || target.el, media)) return;
        }
        handleMediaInterstitial(target.el, tweet);
    }

    function enqueueAll() {
        if (!document.body) return;
        const targets = collectGateElements();
        for (const t of targets) {
            if (alreadyProcessed(t.el)) continue;
            queue.push(t);
        }
        drain();
    }

    function drain() {
        while (queue.length && activeReqs < MAX_CONCURRENT) {
            const target = queue.shift();
            if (!target?.el || !document.contains(target.el) || alreadyProcessed(target.el)) continue;
            activeReqs++;
            processTarget(target).finally(() => {
                activeReqs--;
                setTimeout(drain, 200);
            });
        }
    }

    function scheduleScan() {
        if (scanPending) return;
        scanPending = true;
        requestAnimationFrame(() => {
            scanPending = false;
            enqueueAll();
        });
    }

    function injectCss() {
        if (document.getElementById('fxt-css')) return;
        const s = document.createElement('style');
        s.id = 'fxt-css';
        s.textContent = [
            '.fxt-media,.fxt-quote-card,.fxt-tweet{width:100%!important;max-width:100%!important;box-sizing:border-box}',
            '.fxt-media{border-radius:16px;overflow:hidden}',
            '.fxt-media-grid{width:100%;height:100%;min-height:0}',
            '.fxt-media-grid > div{min-width:0;min-height:0}',
        ].join('');
        document.documentElement.appendChild(s);
    }

    injectCss();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', enqueueAll);
    } else {
        enqueueAll();
    }

    const startObserver = () => {
        if (!document.body) return;
        new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver);

    [1200, 3000, 7000].forEach(ms => setTimeout(enqueueAll, ms));

    console.log('[Age Restriction Bypass] Active');
})();
