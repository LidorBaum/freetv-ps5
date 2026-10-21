/*
 * FreeTV for jailbroken PS5: views, navigation and playback.
 *
 * Plain ES5 on purpose -- the console's WebKit is older than it looks.
 */
(function () {
    "use strict";

    var VERSION = "0.1.0";
    var K = Input.KEY;

    function $(id) {
        return document.getElementById(id);
    }

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) {
            e.className = cls;
        }
        if (text !== undefined && text !== null) {
            e.textContent = text;
        }
        return e;
    }

    function pad2(n) {
        return (n < 10 ? "0" : "") + n;
    }

    // Times are FreeTV's schedule, so they read in Israel time whatever zone
    // the console happens to be set to.
    var israelTime = (function () {
        try {
            return new Intl.DateTimeFormat("en-GB", {
                timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit",
                hour12: false
            });
        } catch (e) {
            return null;
        }
    }());

    function hhmm(date) {
        if (israelTime) {
            return israelTime.format(date);
        }
        return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }

    function clockTime(sec) {
        if (!isFinite(sec) || sec < 0) {
            return "--:--";
        }
        sec = Math.floor(sec);
        var h = Math.floor(sec / 3600);
        var m = Math.floor(sec / 60) % 60;
        var s = sec % 60;
        return (h ? h + ":" + pad2(m) : m) + ":" + pad2(s);
    }

    function noop() {}

    // The console lays out at 1920x1080 but draws at twice that, so images
    // are asked for at double size to stay sharp. Capped at 2: beyond that
    // they only cost bandwidth.
    var DPR = Math.min(2, window.devicePixelRatio || 1);

    var content = $("content");
    var rail = $("rail");
    var video = $("video");

    /* ---------------------------------------------------- toast, diag */

    var toastTimer = null;

    function toast(msg, ms) {
        var t = $("toast");
        t.textContent = msg;
        t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            t.hidden = true;
        }, ms || 3500);
    }

    var diagLines = [];

    /*
     * A development build can ship its diag lines to a computer on the LAN
     * (make LOG_SINK=http://<ip>:<port>/log), since there is no console to
     * attach to on the PS5. text/plain keeps each POST a simple request: no
     * preflight.
     */
    var sinkQueue = [];
    var sinkTimer = null;

    function flushSink() {
        sinkTimer = null;
        if (!sinkQueue.length) {
            return;
        }
        var body = sinkQueue.join("\n");
        sinkQueue = [];
        fetch(window.FREETV_LOG_SINK, {
            method: "POST",
            headers: {"Content-Type": "text/plain"},
            body: body
        })["catch"](noop);
    }

    // Everything worth knowing about a failed stream ends up here, readable on
    // the TV with Triangle.
    function diag(msg) {
        var t = new Date(FreeTV.now());
        var line = pad2(t.getHours()) + ":" + pad2(t.getMinutes()) + ":" +
            pad2(t.getSeconds()) + " " + msg;
        diagLines.push(line);
        if (diagLines.length > 120) {
            diagLines.shift();
        }
        if (window.console && console.log) {
            console.log("[freetv] " + msg);
        }
        if (window.FREETV_LOG_SINK) {
            sinkQueue.push(line);
            if (!sinkTimer) {
                sinkTimer = setTimeout(flushSink, 1000);
            }
        }
        if (!$("diag").hidden) {
            renderDiag();
        }
    }

    function renderDiag() {
        var head = [
            "FreeTV PS5 " + VERSION,
            "device " + FreeTV.deviceUid() +
                (FreeTV.signedIn() ? "  [signed in]" : "  [anonymous]"),
            "caps " + caps.summary,
            "images ok=" + images.ok + " failed=" + images.failed +
                " waiting=" + pending.length,
            "ua " + navigator.userAgent,
            ""
        ];
        $("diag").textContent = head.concat(diagLines.slice(-45)).join("\n");
    }

    function toggleDiag() {
        var d = $("diag");
        d.hidden = !d.hidden;
        if (!d.hidden) {
            renderDiag();
        }
    }

    function shorten(url) {
        return url && url.length > 150 ? url.substring(0, 147) + "..." : url;
    }

    var loads = 0;

    function loading(on) {
        loads = Math.max(0, loads + (on ? 1 : -1));
        $("loadbar").hidden = loads === 0;
    }

    /* ------------------------------------------------------ capabilities */

    var caps = {playready: false, widevine: false, summary: "?"};

    function nativeHls() {
        return !!(video.canPlayType &&
                  (video.canPlayType("application/vnd.apple.mpegurl") ||
                   video.canPlayType("application/x-mpegurl")));
    }

    function keySystem(name) {
        if (!navigator.requestMediaKeySystemAccess) {
            return Promise.resolve(false);
        }
        return navigator.requestMediaKeySystemAccess(name, [{
            initDataTypes: ["cenc"],
            videoCapabilities: [{contentType: 'video/mp4;codecs="avc1.42E01E"'}],
            audioCapabilities: [{contentType: 'audio/mp4;codecs="mp4a.40.2"'}]
        }]).then(function () {
            return true;
        }, function () {
            return false;
        });
    }

    // The console offers PlayReady through EME and neither Widevine nor
    // FairPlay; a desktop browser is usually the other way round. Both are
    // probed so the same build can be tried on a PC.
    function probeCaps() {
        var ms = window.MediaSource || window.WebKitMediaSource;

        function mse(type) {
            try {
                return !!(ms && ms.isTypeSupported(type));
            } catch (e) {
                return false;
            }
        }

        var base = "mse=" + (ms ? "y" : "n") +
            " avc=" + (mse('video/mp4; codecs="avc1.640028"') ? "y" : "n") +
            " hevc=" + (mse('video/mp4; codecs="hvc1.1.6.L120.90"') ? "y" : "n") +
            " nativehls=" + (nativeHls() ? "y" : "n");
        caps.summary = base;

        return Promise.all([
            keySystem("com.microsoft.playready"),
            keySystem("com.widevine.alpha")
        ]).then(function (res) {
            caps.playready = res[0];
            caps.widevine = res[1];
            caps.summary = base + " playready=" + (res[0] ? "y" : "n") +
                " widevine=" + (res[1] ? "y" : "n");
            diag("caps " + caps.summary);
        });
    }

    /* ------------------------------------------------------------ cache */

    var cache = {};

    function cached(key, ttl, fetcher) {
        var hit = cache[key];
        if (hit && Date.now() - hit.at < ttl) {
            return Promise.resolve(hit.value);
        }
        return fetcher().then(function (value) {
            cache[key] = {at: Date.now(), value: value};
            return value;
        });
    }

    function dropCache() {
        cache = {};
    }

    /* -------------------------------------------------------------- EPG */

    var epg = {};          // liveId -> programmes, oldest first
    var epgAt = {};        // liveId -> when fetched

    function loadEpg(ids) {
        var stale = ids.filter(function (id) {
            return !epgAt[id] || Date.now() - epgAt[id] > 10 * 60 * 1000;
        });
        if (!stale.length) {
            return Promise.resolve();
        }
        var now = FreeTV.now();
        return FreeTV.programmes(stale, new Date(now - 4 * 3600 * 1000),
                                 new Date(now + 3 * 3600 * 1000))
            .then(function (list) {
                stale.forEach(function (id) {
                    epg[id] = [];
                    epgAt[id] = Date.now();
                });
                list.forEach(function (p) {
                    var id = p.live && p.live.id;
                    if (id && epg[id]) {
                        epg[id].push(p);
                    }
                });
                stale.forEach(function (id) {
                    epg[id].sort(function (a, b) {
                        return Date.parse(a.since) - Date.parse(b.since);
                    });
                });
            });
    }

    function onAir(liveId) {
        var now = FreeTV.now();
        var list = epg[liveId] || [];
        for (var i = 0; i < list.length; i++) {
            if (Date.parse(list[i].since) <= now && Date.parse(list[i].till) > now) {
                return {now: list[i], next: list[i + 1] || null};
            }
        }
        return null;
    }

    function onAirText(liveId) {
        var air = onAir(liveId);
        if (!air) {
            return "";
        }
        // LRM marks keep the time range in one piece inside RTL text.
        return "‎" + hhmm(new Date(Date.parse(air.now.since))) + "-" +
            hhmm(new Date(Date.parse(air.now.till))) + "‎  " + air.now.title;
    }

    /* ------------------------------------------------------------ cards */

    /*
     * Thumbnails load as they come near the screen.
     *
     * By geometry rather than IntersectionObserver: the observer version left
     * every thumbnail a placeholder on the console, and getBoundingClientRect
     * works on any WebKit. Loading all of them up front is no answer -- the
     * home page alone is ~850 cards. So: whatever is within half a screen of
     * the viewport, checked after every draw, focus move and scroll.
     */
    var pending = [];
    var lazyTimer = null;
    var images = {ok: 0, failed: 0};

    function reveal(img) {
        var src = img.getAttribute("data-src");
        if (src) {
            img.removeAttribute("data-src");
            img.onload = function () {
                images.ok++;
            };
            img.onerror = function () {
                images.failed++;
                if (images.failed <= 5) {
                    diag("image failed: " + shorten(src));
                }
                var fallback = img.getAttribute("data-fallback");
                if (fallback) {
                    img.removeAttribute("data-fallback");
                    img.className += " fallback";
                    img.src = fallback;
                }
            };
            img.src = src;
        }
    }

    function revealVisible() {
        lazyTimer = null;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        pending = pending.filter(function (img) {
            if (!img.getAttribute("data-src") || !document.body.contains(img)) {
                return false;
            }
            var r = img.getBoundingClientRect();
            if (!r.width && !r.height) {
                return true;
            }
            if (r.bottom < -vh / 2 || r.top > vh * 1.5 ||
                r.right < -vw / 2 || r.left > vw * 1.5) {
                return true;
            }
            reveal(img);
            return false;
        });
    }

    function scheduleReveal() {
        if (!lazyTimer) {
            lazyTimer = setTimeout(revealVisible, 60);
        }
    }

    document.addEventListener("scroll", scheduleReveal, true);
    window.addEventListener("resize", scheduleReveal);
    Input.setFocusListener(scheduleReveal);

    function lazyImage(src, fallback) {
        var img = el("img");
        img.alt = "";
        if (src) {
            img.setAttribute("data-src", src);
            if (fallback) {
                img.setAttribute("data-fallback", fallback);
            }
            pending.push(img);
            scheduleReveal();
        }
        return img;
    }

    /*
     * Live frames go stale, so the ones on screen are fetched again every
     * minute while browsing. The query parameter only defeats the browser's
     * cache; the CDN itself keeps a frame for two seconds.
     *
     * Each new frame is loaded off-screen and swapped in only once it is
     * there, a few at a time: refreshing every card at once in place made a
     * burst of them fail on the console, and a failed refresh should leave
     * the old frame up rather than fall back to the logo.
     */
    function refreshFrames() {
        if (mode !== "browse") {
            return;
        }
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var delay = 0;
        liveCards.forEach(function (c) {
            var frame = c._frame;
            if (!frame || !frame.getAttribute("src") ||
                frame.className.indexOf("fallback") >= 0 ||
                !document.body.contains(c)) {
                return;
            }
            var r = frame.getBoundingClientRect();
            if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
                return;
            }
            delay += 200;
            setTimeout(function () {
                var url = c._frameSrc + "&t=" + Date.now();
                var next = new Image();
                next.onload = function () {
                    frame.src = url;
                };
                next.src = url;
            }, delay);
        });
    }

    setInterval(refreshFrames, 60 * 1000);

    // Cards showing a live channel, so the on-air line can be filled in once
    // the EPG arrives.
    var liveCards = [];

    function playable(item) {
        return item && (item.type === "LIVE" || item.type === "VOD" ||
                        item.type === "EPISODE" || item.type === "PROGRAMME");
    }

    function openable(item) {
        return playable(item) || (item && item.type === "SERIAL");
    }

    function card(item, list, index) {
        // A live channel shows what it is airing, with its logo on top, the
        // way the official apps do; the logo alone is the fallback.
        var frameSrc = item.type === "LIVE" ? FreeTV.slide(item, 480 * DPR, 270 * DPR) : "";
        var logoSrc = FreeTV.image(item, "16x9", 480 * DPR, 270 * DPR);
        var c = el("div", "card focusable" + (item.type === "LIVE"
                                              ? (frameSrc ? " live-frame" : " channel")
                                              : ""));
        c._ftv = {item: item, list: list, index: index};

        var thumb = el("div", "thumb");
        if (frameSrc) {
            c._frame = lazyImage(frameSrc, logoSrc);
            c._frameSrc = frameSrc;
            thumb.appendChild(c._frame);
            var logo = lazyImage(FreeTV.image(item, "16x9", 480 * DPR, 270 * DPR));
            logo.className = "channel-logo";
            thumb.appendChild(logo);
        } else {
            thumb.appendChild(lazyImage(logoSrc));
        }

        var badge = null;
        var sub = "";
        if (item.type === "LIVE") {
            badge = el("span", "badge live", "חי");
            liveCards.push(c);
        } else if (item.type === "SERIAL") {
            if (item.seasonCount) {
                badge = el("span", "badge", item.seasonCount > 1
                           ? item.seasonCount + " עונות" : "עונה אחת");
            }
            sub = item.episodeCount ? item.episodeCount + " פרקים" : "";
        } else if (item.type === "EPISODE") {
            badge = el("span", "badge", "פרק " + (item.number || ""));
            sub = (item.season && item.season.title) || "";
        } else if (item.type === "PROGRAMME") {
            var since = new Date(Date.parse(item.since));
            badge = el("span", "badge", hhmm(since));
            sub = ((item.live && item.live.title) || "") + "  " +
                pad2(since.getDate()) + "/" + pad2(since.getMonth() + 1);
        } else if (item.type === "VOD") {
            var bits = [];
            if (item.year) {
                bits.push(item.year);
            }
            if (item.duration) {
                bits.push(Math.round(item.duration / 60) + " דק׳");
            }
            sub = bits.join(" • ");
        }
        if (badge) {
            thumb.appendChild(badge);
        }
        c.appendChild(thumb);

        var meta = el("div", "meta");
        meta.appendChild(el("div", "title", item.title || ""));
        var subEl = el("div", "sub", sub);
        meta.appendChild(subEl);
        c.appendChild(meta);
        c._sub = subEl;
        return c;
    }

    function fillOnAir() {
        var ids = [];
        liveCards.forEach(function (c) {
            var id = c._ftv.item.id;
            if (ids.indexOf(id) < 0) {
                ids.push(id);
            }
        });
        if (!ids.length) {
            return;
        }
        var cards = liveCards;
        loadEpg(ids).then(function () {
            cards.forEach(function (c) {
                c._sub.textContent = onAirText(c._ftv.item.id);
            });
        }, function (err) {
            diag("epg: " + err.message);
        });
    }

    function button(label, action) {
        var b = el("div", "button focusable", label);
        b._ftv = {action: action};
        return b;
    }

    /* ------------------------------------------------------------ views */

    var VIEWS = [
        {id: "home", label: "בית", render: renderHome},
        {id: "live", label: "ערוצים", render: renderLive},
        {id: "account", label: "חשבון", render: renderAccount}
    ];

    var area = "rail";        // which half has the cursor
    var levels = [];          // [rail view, pushed detail views...]
    var renderToken = 0;
    var railTimer = null;

    function buildRail() {
        VIEWS.forEach(function (view) {
            var item = el("div", "rail-item focusable", view.label);
            item._view = view;
            rail.appendChild(item);
        });
    }

    function markRail(view) {
        Array.prototype.forEach.call(rail.children, function (item) {
            item.className = item.className.replace(/\s*\bactive\b/, "") +
                (item._view === view ? " active" : "");
        });
    }

    function setCrumb() {
        $("crumb").textContent = levels.map(function (l) {
            return l.title;
        }).join("  ›  ");
    }

    function openView(view, takeFocus) {
        stopPairing();
        levels = [{title: view.label, render: view.render, lastFocus: 0}];
        markRail(view);
        draw(levels[0], 0, takeFocus);
    }

    // Draw a level into the content pane. Each draw takes a number, and any
    // async work it started checks the number before touching the DOM, so a
    // quick run down the rail never paints a stale view over the new one.
    function draw(level, focusIndex, takeFocus) {
        var my = ++renderToken;
        content.innerHTML = "";
        content.scrollTop = 0;
        liveCards = [];
        setCrumb();
        loading(true);
        var done = Promise.resolve().then(function () {
            return level.render(my);
        });
        done.then(function () {
            loading(false);
            if (my !== renderToken) {
                return;
            }
            fillOnAir();
            scheduleReveal();
            if (takeFocus) {
                if (Input.all(content).length) {
                    area = "content";
                    Input.focusIndex(focusIndex || 0, content);
                } else {
                    focusRail();
                }
            }
        }, function (err) {
            loading(false);
            if (my !== renderToken) {
                return;
            }
            diag("view: " + (err && err.message));
            content.appendChild(el("div", "error",
                                   "שגיאה בטעינה: " + ((err && err.message) || err)));
            var retry = button("נסה שוב", redraw);
            content.appendChild(retry);
            if (takeFocus) {
                area = "content";
                Input.focus(retry);
            }
        });
    }

    function top() {
        return levels[levels.length - 1];
    }

    function push(title, render) {
        stopPairing();
        top().lastFocus = Input.indexOfFocused(content);
        levels.push({title: title, render: render, lastFocus: 0});
        draw(top(), 0, true);
    }

    function back() {
        if (levels.length > 1) {
            levels.pop();
            draw(top(), top().lastFocus, true);
        } else {
            focusRail();
        }
    }

    function redraw() {
        dropCache();
        epgAt = {};
        draw(top(), Math.max(0, Input.indexOfFocused(content)), area === "content");
    }

    function focusRail() {
        if (levels.length) {
            top().lastFocus = Math.max(0, Input.indexOfFocused(content));
        }
        area = "rail";
        var active = rail.querySelector(".active") || rail.firstChild;
        Input.focus(active);
    }

    function enterContent() {
        if (!Input.all(content).length) {
            return;
        }
        area = "content";
        Input.focusIndex(top().lastFocus || 0, content);
    }

    function row(title, items) {
        var r = el("div", "row");
        r.appendChild(el("div", "row-title", title));
        var track = el("div", "row-track");
        items.forEach(function (item, i) {
            track.appendChild(card(item, items, i));
        });
        r.appendChild(track);
        return r;
    }

    function renderHome(my) {
        return cached("home", 5 * 60 * 1000, function () {
            return FreeTV.sections("main", 24);
        }).then(function (sections) {
            if (my !== renderToken) {
                return;
            }
            var shown = 0;
            sections.forEach(function (section) {
                // The banner row (titled דף הבית) is the website's hero
                // carousel; on the console it only repeats a channel.
                if (section.layout === "BANNER") {
                    return;
                }
                var items = (section.elements || []).map(function (e) {
                    return e.item;
                }).filter(openable);
                if (!items.length) {
                    return;
                }
                content.appendChild(row((section.title || "").trim(), items));
                shown++;
            });
            if (!shown) {
                content.appendChild(el("div", "empty", "אין תוכן להצגה"));
            }
        });
    }

    function renderLive(my) {
        return cached("lives", 10 * 60 * 1000, FreeTV.lives).then(function (channels) {
            if (my !== renderToken) {
                return;
            }
            var list = channels.filter(function (c) {
                return c.type === "LIVE" && c.visibleOnZapper !== false;
            });
            var grid = el("div", "grid");
            list.forEach(function (c, i) {
                grid.appendChild(card(c, list, i));
            });
            content.appendChild(grid);
        });
    }

    function renderSerial(item) {
        return function (my) {
            return Promise.all([
                FreeTV.serial(item.id)["catch"](function () {
                    return item;
                }),
                FreeTV.seasons(item.id)
            ]).then(function (res) {
                if (my !== renderToken) {
                    return;
                }
                var serial = res[0] || item;
                var seasons = res[1].slice().sort(function (a, b) {
                    return (a.number || 0) - (b.number || 0);
                });

                var hero = el("div", "hero");
                hero.appendChild(lazyImage(FreeTV.image(serial, "16x9", 960 * DPR, 540 * DPR)));
                var info = el("div", "info");
                info.appendChild(el("h1", null, serial.title));
                info.appendChild(el("p", null, serial.description || serial.lead || ""));
                hero.appendChild(info);
                content.appendChild(hero);

                if (!seasons.length) {
                    content.appendChild(el("div", "empty", "אין פרקים זמינים"));
                    return;
                }

                var bar = el("div", "buttons");
                var grid = el("div", "grid");
                var buttons = [];
                var seasonToken = 0;

                function showSeason(season, b) {
                    var mine = ++seasonToken;
                    buttons.forEach(function (x) {
                        x.className = x.className.replace(/\s*\bactive\b/, "") +
                            (x === b ? " active" : "");
                    });
                    grid.innerHTML = "";
                    loading(true);
                    FreeTV.episodes(item.id, season.id).then(function (eps) {
                        loading(false);
                        if (my !== renderToken || mine !== seasonToken) {
                            return;
                        }
                        eps = eps.slice().sort(function (a, b2) {
                            return (a.number || 0) - (b2.number || 0);
                        });
                        eps.forEach(function (ep, i) {
                            ep.season = ep.season || season;
                            grid.appendChild(card(ep, eps, i));
                        });
                        if (!eps.length) {
                            grid.appendChild(el("div", "empty", "אין פרקים בעונה הזו"));
                        }
                    }, function (err) {
                        loading(false);
                        grid.appendChild(el("div", "error", "שגיאה: " + err.message));
                    });
                }

                seasons.forEach(function (season) {
                    var b = button(season.number ? "עונה " + season.number
                                   : (season.title || "עונה"), function () {
                                       showSeason(season, b);
                                   });
                    buttons.push(b);
                    bar.appendChild(b);
                });
                content.appendChild(bar);
                content.appendChild(grid);
                showSeason(seasons[0], buttons[0]);
            });
        };
    }

    /* ---------------------------------------------------------- account */

    var pairing = null;
    var sms = null;

    // Stops both ways of waiting for a login: leaving the account view should
    // not leave a poller running behind it.
    function stopPairing() {
        if (pairing) {
            clearInterval(pairing.timer);
            pairing = null;
        }
        if (sms) {
            clearInterval(sms.timer);
            sms = null;
        }
    }

    function smsError(err) {
        var code = (err && err.code) || "";
        if (/MSISDN_(BLANK|INVALID)|INVALID_MSISDN/.test(code)) {
            return "מספר הטלפון לא תקין";
        }
        if (/ATTEMPTS_EXCEEDED/.test(code)) {
            return "יותר מדי ניסיונות. נסו שוב מאוחר יותר.";
        }
        if (/NOT_EXISTS|NOT_FOUND/.test(code)) {
            return "הקוד שגוי או שפג תוקפו";
        }
        return "שגיאה: " + ((err && err.message) || err);
    }

    function startSms(number, box) {
        var msisdn = (number || "").replace(/\D/g, "");
        if (msisdn.indexOf("972") === 0) {
            msisdn = "0" + msisdn.substring(3);
        }
        if (!/^05\d{8}$/.test(msisdn)) {
            toast("מספר טלפון לא תקין (05XXXXXXXX)");
            return;
        }
        stopPairing();
        box.innerHTML = "";
        box.appendChild(el("p", null, "שולח SMS..."));

        FreeTV.sendSms(msisdn).then(function (res) {
            var mine = sms = {uuid: res.uuid, busy: false, timer: null,
                              until: Date.now() + 10 * 60 * 1000};
            diag("sms: sent, attempt " + res.uuid);
            box.innerHTML = "";
            box.appendChild(el("p", null, "הקוד נשלח ל-" + msisdn +
                               ". הקלידו אותו כאן, או אשרו דרך הקישור שב-SMS:"));
            var code = field("tel", "קוד מה-SMS");
            var status = el("p");
            box.appendChild(code);
            box.appendChild(button("אישור", function () {
                var digits = code.value.replace(/\D/g, "");
                if (!digits) {
                    toast("הקלידו את הקוד מה-SMS");
                    return;
                }
                status.textContent = "מאמת...";
                FreeTV.verifySms(mine.uuid, digits).then(function () {
                    finishSms(mine, status);
                }, function (err) {
                    diag("sms verify: " + err.message);
                    status.textContent = smsError(err);
                });
            }));
            box.appendChild(status);
            Input.focus(code);

            // The SMS link confirms the attempt without the code ever
            // reaching the console, so keep asking whether it went through.
            mine.timer = setInterval(function () {
                if (Date.now() > mine.until) {
                    stopPairing();
                    status.textContent = "פג תוקף. שלחו קוד חדש.";
                    return;
                }
                finishSms(mine, status);
            }, 4000);
        }, function (err) {
            diag("sms send: " + err.message);
            box.innerHTML = "";
            box.appendChild(el("p", "error", smsError(err)));
        });
    }

    function finishSms(mine, status) {
        if (sms !== mine || mine.busy) {
            return;
        }
        mine.busy = true;
        FreeTV.loginWithSms(mine.uuid).then(function () {
            if (sms !== mine) {
                return;
            }
            stopPairing();
            diag("sms: signed in");
            toast("התחברת בהצלחה");
            signedInChanged();
        }, function (err) {
            mine.busy = false;
            if (err.code !== "MSISDN_LOGIN_CODE_EXPIRED_OR_NOT_EXISTS") {
                diag("sms login: " + err.message);
                status.textContent = smsError(err);
            }
        });
    }

    function signedInChanged() {
        dropCache();
        epgAt = {};
        draw(top(), 0, true);
    }

    function startPairing(box) {
        stopPairing();
        box.innerHTML = "";
        box.appendChild(el("p", null, "מבקש קוד..."));
        FreeTV.requestCode().then(function (res) {
            var expires = Date.parse(res.expiresAt) || FreeTV.now() + 15 * 60 * 1000;
            pairing = {code: String(res.code), expires: expires, busy: false, timer: null};
            diag("pair: code issued, expires " + res.expiresAt);
            box.innerHTML = "";
            box.appendChild(el("p", null, "היכנסו לכתובת הבאה מהטלפון או מהמחשב, מחוברים לחשבון FreeTV:"));
            box.appendChild(el("p", "ltr", FreeTV.PAIR_URL));
            box.appendChild(el("div", "code", pairing.code));
            var status = el("p", null, "ממתין לאישור... (בתוקף עד " +
                            hhmm(new Date(expires)) + ")");
            box.appendChild(status);
            var mine = pairing;
            pairing.timer = setInterval(function () {
                pollPairing(mine, status);
            }, 5000);
        }, function (err) {
            box.innerHTML = "";
            box.appendChild(el("p", "error", "לא ניתן לקבל קוד: " + err.message));
        });
    }

    // Until the code is confirmed the login answers
    // DEVICE_CODE_EXPIRED_OR_NOT_EXISTS, so that is not an error here; the
    // expiry from the code request is what ends the wait.
    function pollPairing(mine, status) {
        if (pairing !== mine || mine.busy) {
            return;
        }
        if (FreeTV.now() > mine.expires) {
            stopPairing();
            status.textContent = "תוקף הקוד פג. בקשו קוד חדש.";
            return;
        }
        mine.busy = true;
        FreeTV.loginWithCode(mine.code).then(function () {
            if (pairing !== mine) {
                return;
            }
            stopPairing();
            diag("pair: signed in");
            toast("התחברת בהצלחה");
            signedInChanged();
        }, function (err) {
            mine.busy = false;
            if (err.code !== "DEVICE_CODE_EXPIRED_OR_NOT_EXISTS") {
                diag("pair poll: " + err.message);
            }
        });
    }

    // A text field holds the on-screen keyboard while it has focus, so the
    // pad is handed back to the browser until the field lets go.
    function field(type, placeholder) {
        var f = document.createElement("input");
        f.type = type;
        f.placeholder = placeholder;
        f.className = "field focusable";
        f.setAttribute("dir", "ltr");
        f._ftv = {action: function () {
            Input.suspend();
            f.focus();
        }};
        f.addEventListener("blur", function () {
            Input.resume();
        });
        f.addEventListener("keydown", function (e) {
            if ((e.keyCode || e.which) === 13) {
                f.blur();
            }
        });
        return f;
    }

    function renderAccount(my) {
        var panel = el("div", "panel");

        if (FreeTV.signedIn()) {
            panel.appendChild(el("h2", null, "מחובר ל-FreeTV"));
            var who = el("p", null, "בודק חשבון...");
            panel.appendChild(who);
            FreeTV.detail().then(function (d) {
                if (my === renderToken) {
                    who.textContent = [d.email, d.msisdn, d.login].filter(function (x) {
                        return !!x;
                    })[0] || "החשבון פעיל";
                }
            }, function (err) {
                if (my === renderToken) {
                    who.textContent = "בדיקת החשבון נכשלה: " + err.message;
                }
            });
            panel.appendChild(button("התנתקות", function () {
                FreeTV.logout().then(function () {
                    toast("התנתקת");
                    signedInChanged();
                });
            }));
        } else {
            panel.appendChild(el("h2", null, "התחברות"));
            panel.appendChild(el("p", null,
                                 "עם מספר הטלפון של החשבון. נשלח אליכם קוד ב-SMS."));
            var phone = field("tel", "05XXXXXXXX");
            var smsBox = el("div");
            panel.appendChild(phone);
            panel.appendChild(button("שלחו לי קוד", function () {
                startSms(phone.value, smsBox);
            }));
            panel.appendChild(smsBox);

            panel.appendChild(el("p", null,
                                 "או עם קוד חיבור, כמו בטלוויזיה חכמה:"));
            var box = el("div");
            panel.appendChild(button("קבלת קוד חיבור", function () {
                startPairing(box);
            }));
            panel.appendChild(box);

            panel.appendChild(el("p", null, "או עם אימייל וסיסמה:"));
            var email = field("email", "אימייל");
            var password = field("password", "סיסמה");
            panel.appendChild(email);
            panel.appendChild(password);
            panel.appendChild(button("התחברות", function () {
                if (!email.value || !password.value) {
                    toast("יש למלא אימייל וסיסמה");
                    return;
                }
                loading(true);
                FreeTV.loginWithPassword(email.value.trim(), password.value).then(function () {
                    loading(false);
                    toast("התחברת בהצלחה");
                    signedInChanged();
                }, function (err) {
                    loading(false);
                    diag("password login: " + err.message);
                    toast(err.code === "CAPTCHA_REQUIRED" || /CAPTCHA/.test(err.code)
                          ? "השרת דורש CAPTCHA. השתמשו בקוד חיבור."
                          : "ההתחברות נכשלה: " + err.code, 6000);
                });
            }));
        }

        panel.appendChild(el("p", "ltr", "device " + FreeTV.deviceUid() + "  ·  v" + VERSION));
        panel.appendChild(button("מידע טכני", toggleDiag));
        content.appendChild(panel);
        return Promise.resolve();
    }

    /* ----------------------------------------------------------- player */

    var mode = "browse";
    var playToken = 0;
    var now = null;
    var hlsPlayer = null;
    var shakaPlayer = null;
    var startTimer = null;
    var returnFocus = null;
    var osdTimer = null;
    var tick = null;

    function loadScript(src, ready) {
        if (ready()) {
            return Promise.resolve();
        }
        return new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = function () {
                reject(new Error(src + " failed to load"));
            };
            document.head.appendChild(s);
        });
    }

    function playVideo() {
        var p = video.play();
        if (p && p["catch"]) {
            p["catch"](noop);
        }
    }

    /*
     * Which ways to try, in order.
     *
     * Encrypted: DASH through Shaka with whichever licence server the browser
     * has a CDM for -- PlayReady on the console. (The MP4 such titles list is
     * encrypted too, so it is no fallback.) Clear: hls.js first, since
     * WebKit's own HLS on the console plays no sound when audio sits in a
     * rendition of its own (as FreeTV's does); then DASH, then the native
     * player, then the plain MP4 some titles carry.
     */
    function plan(info) {
        var steps = [];
        // Each source is tried from the Israeli CDN first (see israel() in
        // freetv.js) and from the address FreeTV gave second.
        function both(engine, near, far, drm) {
            if (near) {
                steps.push({engine: engine, url: near, drm: drm});
            }
            if (far) {
                steps.push({engine: engine, url: far, drm: drm});
            }
        }
        if (info.encrypted) {
            if (info.licence) {
                both("shaka", info.dashNear, info.dash, info.licence);
            }
        } else {
            both("hlsjs", info.hlsNear, info.hls);
            both("shaka", info.dashNear, info.dash);
            if (nativeHls()) {
                both("native", info.hlsNear, info.hls);
            }
            both("native", info.mp4Near, info.mp4);
        }
        return steps;
    }

    function stopEngine() {
        clearTimeout(startTimer);
        if (hlsPlayer) {
            try {
                hlsPlayer.destroy();
            } catch (e) {
                // already gone
            }
            hlsPlayer = null;
        }
        if (shakaPlayer) {
            var s = shakaPlayer;
            shakaPlayer = null;
            s.destroy()["catch"](noop);
        }
        try {
            video.pause();
            video.removeAttribute("src");
            video.load();
        } catch (e) {
            // nothing loaded
        }
    }

    function teardown() {
        stopEngine();
        if (now && now.close) {
            now.close();
            now.close = null;
        }
    }

    function play(item, list, index) {
        var my = ++playToken;
        teardown();
        if (mode !== "player") {
            returnFocus = Input.current();
        }
        now = {item: item, list: list || [item], index: index || 0, errors: [],
               started: false};
        mode = "player";
        $("player").hidden = false;
        $("browser").style.visibility = "hidden";
        $("spinner").hidden = false;
        osd();
        diag("play " + item.type + " " + item.id + " " + item.title);

        if (item.type === "LIVE") {
            loadEpg([item.id]).then(function () {
                if (my === playToken) {
                    osd();
                }
            }, noop);
        }

        FreeTV.playback(item).then(function (info) {
            if (my !== playToken) {
                return;
            }
            now.info = info;
            diag("sources hls=" + !!info.hls + " dash=" + !!info.dash +
                 " mp4=" + !!info.mp4 + " drm=" + info.encrypted +
                 (info.licence ? " pr=" + !!info.licence.playready : "") +
                 " session=" + (info.session.id || "-") +
                 (info.configError ? " config=" + info.configError.code : ""));
            now.close = FreeTV.holdSession(info, function (err) {
                diag("session lost: " + err.message);
                toast("הצפייה הופסקה: " + err.code, 6000);
            });
            now.steps = plan(info);
            if (!now.steps.length) {
                throw new Error(info.encrypted
                                ? "התוכן מוצפן ואין מקור DASH מתאים"
                                : "לא נמצא מקור וידאו");
            }
            attempt(my, 0);
        })["catch"](function (err) {
            if (my === playToken) {
                fail(err);
            }
        });
    }

    function attempt(my, i) {
        if (my !== playToken) {
            return;
        }
        var step = now.steps[i];
        if (!step) {
            diag("all engines failed: " + now.errors.join(" | "));
            if (now.info.configError) {
                fail(now.info.configError);
            } else if (!FreeTV.signedIn()) {
                // Tokenised streams answer 401 without a session, and a 401
                // without CORS headers reaches the players as a bare network
                // error -- so signed out, this is the likely story.
                fail(new Error("לא ניתן לנגן בלי התחברות. התחברו בלשונית חשבון."));
            } else {
                fail(new Error("הניגון נכשל: " + now.errors.join(" | ")));
            }
            return;
        }
        stopEngine();
        if (step.drm && !caps.playready && !caps.widevine) {
            now.errors.push(step.engine + ": no CDM");
            attempt(my, i + 1);
            return;
        }
        diag("try " + step.engine + (step.drm ? "+drm" : "") + " " + shorten(step.url));

        var over = false;
        now.onStarted = function () {
            if (over) {
                return;
            }
            over = true;
            clearTimeout(startTimer);
            now.started = true;
            $("spinner").hidden = true;
            var track = "";
            if (shakaPlayer) {
                var active = shakaPlayer.getVariantTracks().filter(function (t) {
                    return t.active;
                })[0];
                if (active) {
                    track = ", track " + active.height + "p@" +
                        Math.round(active.bandwidth / 1000) + "k " + active.videoCodec;
                }
            }
            diag("playing via " + step.engine + ", decoded " + video.videoWidth +
                 "x" + video.videoHeight + track);
            osd();
        };
        now.onFatal = function (reason) {
            if (my !== playToken) {
                return;
            }
            if (now.started) {
                fail(new Error(reason));
                return;
            }
            if (over) {
                return;
            }
            over = true;
            clearTimeout(startTimer);
            now.errors.push(step.engine + ": " + reason);
            diag("fail " + step.engine + ": " + reason);
            attempt(my, i + 1);
        };
        startTimer = setTimeout(function () {
            now.onFatal("no picture after 20s");
        }, 20000);

        var start = step.engine === "hlsjs" ? startHlsJs
            : step.engine === "shaka" ? startShaka : startNative;
        start(step, my)["catch"](function (e) {
            if (my === playToken) {
                now.onFatal((e && (e.message || e.code)) || String(e));
            }
        });
    }

    function startHlsJs(step, my) {
        return loadScript("lib/hls.min.js", function () {
            return !!window.Hls;
        }).then(function () {
            if (my !== playToken) {
                return;
            }
            var Hls = window.Hls;
            if (!Hls.isSupported()) {
                throw new Error("hls.js not supported");
            }
            var h = hlsPlayer = new Hls({
                maxBufferLength: 30,
                backBufferLength: 30,
                // Left to itself hls.js assumes a slow line, opens on the
                // smallest rendition and climbs, and the climb is a stall a
                // second into playback. Assume a fast line instead; ABR still
                // steps down if the network really cannot keep up.
                abrEwmaDefaultEstimate: 20000000,
                testBandwidth: false,
                // Four segments behind the live edge leaves room to buffer.
                liveSyncDurationCount: 4,
                // Loading waits until the top rendition has been chosen.
                autoStartLoad: false
            });
            h.on(Hls.Events.ERROR, function (ev, data) {
                if (data && data.fatal && hlsPlayer === h) {
                    now.onFatal("hls " + data.type + "/" + data.details +
                                (data.response && data.response.code
                                 ? " " + data.response.code : ""));
                }
            });
            h.on(Hls.Events.MANIFEST_PARSED, function () {
                var best = 0;
                h.levels.forEach(function (l, i) {
                    var b = h.levels[best];
                    if ((l.height || 0) > (b.height || 0) ||
                        ((l.height || 0) === (b.height || 0) && l.bitrate > b.bitrate)) {
                        best = i;
                    }
                });
                diag("levels " + h.levels.map(function (l) {
                    return (l.height || "?") + "p@" + Math.round(l.bitrate / 1000) + "k";
                }).join(" ") + ", starting " + h.levels[best].height + "p");
                h.startLevel = best;
                h.startLoad(-1);
            });
            h.on(Hls.Events.LEVEL_SWITCHED, function (ev, data) {
                var l = h.levels[data.level];
                if (l && now && now.started) {
                    diag("switched to " + l.height + "p@" + Math.round(l.bitrate / 1000) + "k");
                }
            });
            h.on(Hls.Events.FRAG_BUFFERED, startWhenBuffered);

            // How each of the first segments arrived: a slow line and a slow
            // start to every request look the same to ABR but not here.
            var logged = 0;
            h.on(Hls.Events.FRAG_LOADED, function (ev, data) {
                if (++logged > 10 || !data || !data.frag) {
                    return;
                }
                var st = data.frag.stats || data.stats || {};
                var ld = st.loading || {};
                var ms = (ld.end || 0) - (ld.start || 0);
                var ttfb = (ld.first || 0) - (ld.start || 0);
                diag("frag " + data.frag.type + " L" + data.frag.level + " " +
                     Math.round((st.total || 0) / 1024) + "KB in " +
                     Math.round(ms) + "ms (first byte " + Math.round(ttfb) +
                     "ms) = " + (ms > 0 ? ((st.total || 0) * 8 / ms / 1000).toFixed(1) : "?") +
                     " Mbps, estimate " + (h.bandwidthEstimate / 1e6).toFixed(1));
            });
            h.loadSource(step.url);
            h.attachMedia(video);
        });
    }

    /*
     * One wait, not two: playback only begins once START_BUFFER seconds are
     * in hand. Starting on the first segment, as players do by default, is
     * what produced "loads, plays a second, loads again".
     */
    var START_BUFFER = 6;

    // Seconds buffered from the playhead -- or, before the player has moved
    // the playhead to its start position, from wherever the buffer begins.
    function bufferedAhead() {
        var b = video.buffered;
        var t = video.currentTime;
        for (var i = 0; i < b.length; i++) {
            if (b.end(i) > t) {
                return b.end(i) - Math.max(t, b.start(i));
            }
        }
        return 0;
    }

    function startWhenBuffered() {
        if (!now || now.started || now.released) {
            return;
        }
        if (!now.gateTimer) {
            // Never hold a slow stream back for ever -- but only this
            // stream: by the time it fires the remote may have moved on.
            var mine = now;
            mine.gateTimer = setTimeout(function () {
                if (now === mine && !mine.released) {
                    mine.released = true;
                    playVideo();
                }
            }, 12000);
        }
        if (bufferedAhead() >= START_BUFFER) {
            now.released = true;
            clearTimeout(now.gateTimer);
            playVideo();
        }
    }

    function startShaka(step, my) {
        return loadScript("lib/shaka-player.compiled.js", function () {
            return !!window.shaka;
        }).then(function () {
            if (my !== playToken) {
                return null;
            }
            var shaka = window.shaka;
            shaka.polyfill.installAll();
            if (!shaka.Player.isBrowserSupported()) {
                throw new Error("shaka not supported");
            }
            var p = shakaPlayer = new shaka.Player();
            return p.attach(video).then(function () {
                // Same two rules as for hls.js: open on the best track, and
                // hold playback until START_BUFFER seconds are in.
                var config = {
                    streaming: {bufferingGoal: 30, rebufferingGoal: START_BUFFER},
                    abr: {defaultBandwidthEstimate: 20000000}
                };
                if (step.drm) {
                    var servers = {};
                    if (step.drm.playready) {
                        servers["com.microsoft.playready"] = step.drm.playready;
                    }
                    if (step.drm.widevine) {
                        servers["com.widevine.alpha"] = step.drm.widevine;
                    }
                    config.drm = {servers: servers};
                }
                p.configure(config);

                // The licence endpoints are FreeTV API calls like any other
                // and want the same credentials.
                p.getNetworkingEngine().registerRequestFilter(function (type, req) {
                    if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
                        var h = FreeTV.headers();
                        Object.keys(h).forEach(function (k) {
                            if (k !== "Accept") {
                                req.headers[k] = h[k];
                            }
                        });
                    }
                });
                p.addEventListener("error", function (ev) {
                    if (shakaPlayer === p) {
                        now.onFatal(shakaError(ev.detail));
                    }
                });
                // FreeTV's DASH manifests live at .../Manifest.ism, which
                // Shaka would otherwise take for Smooth Streaming.
                return p.load(step.url, null, "application/dash+xml").then(function () {
                    var keys = p.keySystem && p.keySystem();
                    if (keys) {
                        diag("drm key system " + keys);
                    }
                    playVideo();
                }, function (err) {
                    throw new Error(shakaError(err));
                });
            });
        });
    }

    function shakaError(err) {
        var d = err || {};
        var codes = window.shaka && window.shaka.util.Error.Code;
        var name = "";
        if (codes) {
            Object.keys(codes).some(function (k) {
                if (codes[k] === d.code) {
                    name = k;
                    return true;
                }
                return false;
            });
        }
        return "shaka " + d.code + (name ? " " + name : "") + " " +
            JSON.stringify(d.data || []).substring(0, 160);
    }

    function startNative(step) {
        video.src = step.url;
        video.load();
        playVideo();
        return Promise.resolve();
    }

    video.addEventListener("playing", function () {
        if (now && now.onStarted) {
            now.onStarted();
        }
    });

    video.addEventListener("waiting", function () {
        if (now && now.started) {
            $("spinner").hidden = false;
        }
    });

    video.addEventListener("canplay", function () {
        if (now && now.started) {
            $("spinner").hidden = true;
        }
    });

    // Only the native player reports through the element; hls.js and Shaka
    // report their own, more telling, errors.
    video.addEventListener("error", function () {
        if (now && now.onFatal && !hlsPlayer && !shakaPlayer && video.getAttribute("src")) {
            var e = video.error;
            now.onFatal("media error " + (e ? e.code : "?"));
        }
    });

    function stop() {
        playToken++;
        teardown();
        now = null;
        mode = "browse";
        $("player").hidden = true;
        $("browser").style.visibility = "";
        $("spinner").hidden = true;
        clearInterval(tick);
        if (returnFocus && document.body.contains(returnFocus)) {
            Input.focus(returnFocus);
        }
    }

    function fail(err) {
        var msg = (err && err.message) || String(err);
        diag("playback failed: " + msg);
        stop();
        toast(friendly(err), 7000);
    }

    function friendly(err) {
        var code = err && err.code;
        if (code === "ITEM_NOT_PAID") {
            return "התוכן לא כלול במנוי (או שצריך להתחבר בלשונית חשבון)";
        }
        if (code === "AUTHENTICATION_REQUIRED" || code === "HTTP_401") {
            return "צריך להתחבר כדי לצפות בתוכן הזה";
        }
        if (code === "VIDEO_SESSION_LIMIT_EXCEEDED") {
            return "חרגתם ממספר הצפיות במקביל בחשבון";
        }
        if (/GEO/.test(code || "")) {
            return "התוכן זמין רק מישראל";
        }
        return ((err && err.message) || String(err)) + "  (משולש = פרטים)";
    }

    function osd() {
        if (!now) {
            return;
        }
        var item = now.item;
        $("osd-name").textContent = item.title || "";
        var state = $("osd-state");
        var sub = "";
        if (item.type === "LIVE") {
            state.textContent = "● שידור חי";
            state.className = "live";
            var air = onAir(item.id);
            if (air) {
                sub = "עכשיו: " + air.now.title +
                    (air.next ? "   ·   אחר כך " + hhmm(new Date(Date.parse(air.next.since))) +
                     ": " + air.next.title : "");
            }
        } else {
            state.className = "";
            state.textContent = video.paused && now.started ? "מושהה" : "";
            if (item.type === "EPISODE") {
                sub = ((item.season && item.season.title) || "") + "  ·  פרק " + (item.number || "");
            } else if (item.type === "PROGRAMME") {
                sub = (item.live && item.live.title) || "";
            }
        }
        $("osd-sub").textContent = sub;
        $("osd").className = "";
        clearTimeout(osdTimer);
        osdTimer = setTimeout(function () {
            if (now && now.started && !video.paused) {
                $("osd").className = "hide";
            }
        }, 4000);

        clearInterval(tick);
        tick = setInterval(progress, 500);
        progress();
    }

    function progress() {
        if (!now) {
            return;
        }
        var live = now.item.type === "LIVE";
        var dur = video.duration;
        var t = video.currentTime;
        var finite = isFinite(dur) && dur > 0 && !live;
        $("osd-fill").style.width = finite ? Math.min(100, t / dur * 100) + "%" : "0";
        $("osd-pos").textContent = finite ? clockTime(t) : "";
        $("osd-dur").textContent = finite ? clockTime(dur) : "";
    }

    function seek(delta) {
        if (!now || now.item.type === "LIVE" || !isFinite(video.duration)) {
            osd();
            return;
        }
        video.currentTime = Math.max(0, Math.min(video.duration - 1,
                                                 video.currentTime + delta));
        osd();
    }

    function togglePause() {
        if (!now || !now.started) {
            return;
        }
        if (video.paused) {
            playVideo();
        } else {
            video.pause();
        }
        setTimeout(osd, 50);
    }

    // Step along the list the item came from, skipping anything that only
    // opens (a series) rather than plays.
    function zap(delta) {
        if (!now || now.list.length < 2) {
            return;
        }
        var n = now.list.length;
        var i = now.index;
        for (var tries = 0; tries < n; tries++) {
            i = (i + delta + n) % n;
            if (playable(now.list[i])) {
                play(now.list[i], now.list, i);
                return;
            }
        }
    }

    /* ------------------------------------------------------------- keys */

    function activate(target) {
        var data = target && target._ftv;
        if (!data) {
            return;
        }
        if (data.action) {
            data.action();
            return;
        }
        var item = data.item;
        if (item.type === "SERIAL") {
            push(item.title, renderSerial(item));
        } else if (playable(item)) {
            play(item, data.list, data.index);
        } else {
            toast("סוג תוכן לא נתמך: " + item.type);
        }
    }

    function playerKey(code) {
        switch (code) {
        case K.CIRCLE:
        case K.STOP:
        case K.TOP_MENU:
            stop();
            break;
        case K.CROSS:
        case K.PAUSE:
        case K.GREEN:
            togglePause();
            break;
        case K.LEFT:
            seek(-10);
            break;
        case K.RIGHT:
            seek(10);
            break;
        case K.REWIND:
            seek(-60);
            break;
        case K.FORWARD:
            seek(60);
            break;
        case K.UP:
        case K.CHAN_UP:
        case K.NEXT:
            zap(1);
            break;
        case K.DOWN:
        case K.CHAN_DOWN:
        case K.PREV:
            zap(-1);
            break;
        case K.SQUARE:
        case K.RED:
            play(now.item, now.list, now.index);
            break;
        default:
            osd();
        }
    }

    function browseKey(code) {
        if (area === "rail") {
            if (code === K.UP || code === K.DOWN) {
                var to = Input.move(code === K.UP ? "up" : "down", rail, true);
                if (to) {
                    clearTimeout(railTimer);
                    railTimer = setTimeout(function () {
                        openView(to._view, false);
                    }, 350);
                }
            } else if (code === K.LEFT || code === K.CROSS) {
                // The page is RTL, so the content lies to the left of the rail.
                clearTimeout(railTimer);
                var focused = Input.current(rail);
                if (focused && levels[0] && focused._view.label !== levels[0].title) {
                    openView(focused._view, true);
                } else {
                    enterContent();
                }
            }
            return;
        }

        switch (code) {
        case K.UP:
        case K.DOWN:
        case K.LEFT:
        case K.RIGHT:
            var dir = {37: "left", 38: "up", 39: "right", 40: "down"}[code];
            // No wrapping: in RTL document order runs against the arrows.
            if (!Input.move(dir, content, true) && dir === "right") {
                focusRail();
            }
            break;
        case K.CROSS:
        case K.GREEN:
            activate(Input.current(content));
            break;
        case K.CIRCLE:
            back();
            break;
        case K.SQUARE:
        case K.RED:
            redraw();
            break;
        case K.TOP_MENU:
            focusRail();
            break;
        case K.GUIDE:
            openView(VIEWS[1], true);
            break;
        }
    }

    Input.setHandler(function (code) {
        if (code === K.TRIANGLE || code === K.BLUE) {
            toggleDiag();
            return;
        }
        if (!$("diag").hidden && code === K.CIRCLE) {
            toggleDiag();
            return;
        }
        if (mode === "player") {
            playerKey(code);
        } else {
            browseKey(code);
        }
    });

    /* ------------------------------------------------------------ start */

    function clock() {
        $("clock").textContent = hhmm(new Date(FreeTV.now()));
    }

    window.addEventListener("pagehide", function () {
        teardown();
    });

    clock();
    setInterval(clock, 10000);
    buildRail();
    probeCaps();
    diag("start v" + VERSION + (FreeTV.signedIn() ? ", signed in" : ", anonymous") +
         " " + window.innerWidth + "x" + window.innerHeight +
         " dpr=" + (window.devicePixelRatio || 1) +
         " screen=" + screen.width + "x" + screen.height +
         " io=" + (window.IntersectionObserver ? "y" : "n"));
    diag("ua " + navigator.userAgent);
    setTimeout(function () {
        diag("images after 8s: ok=" + images.ok + " failed=" + images.failed +
             " waiting=" + pending.length + ", clock offset " +
             Math.round(FreeTV.clockOffset() / 1000) + "s");
    }, 8000);

    if (FreeTV.signedIn()) {
        FreeTV.detail().then(function () {
            diag("session ok");
        }, function (err) {
            diag("session check: " + err.message);
            if (!FreeTV.signedIn()) {
                toast("ההתחברות פגה. התחברו שוב בלשונית חשבון.", 6000);
            }
        });
    }

    openView(VIEWS[0], true);
}());
