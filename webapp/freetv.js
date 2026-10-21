/*
 * FreeTV API client.
 *
 * FreeTV runs on Redge Media's RedGalaxy portal. Everything here was read out
 * of the official Android app (React Native, plain JS bundle) and the
 * web.freetv.tv front end:
 *
 *   - every request carries the app's own HTTP Basic credentials plus a
 *     device uid and a device description;
 *   - a signed-in subscriber is identified by the token from the login
 *     response, sent back as API-Authentication -- a header, not a cookie,
 *     so nothing depends on the console's third-party cookie policy;
 *   - the API answers CORS for any origin, credentials included, which is
 *     what lets this run from websrv on http://localhost:8080.
 *
 * The service is geo-locked to Israel.
 */
var FreeTV = (function () {
    "use strict";

    var BASE = "https://web.freetv.tv/api";
    var BASIC = "Basic " + btoa("krs-freetv-prod:oht0ue5taxoo7Ii7");
    var PLATFORM = "BROWSER";
    var APP_VERSION = "ps5-0.1.0";

    // Where a signed-in subscriber types the code shown on the console.
    var PAIR_URL = "https://web.freetv.tv/watch-on-tv";

    /* ------------------------------------------------------------ storage */

    // localStorage only persists for a web app whose param.json asks for
    // storage (downloadDataSize); without it writes vanish silently. Every
    // access is guarded so a refusal degrades to "not signed in".
    var store = {
        get: function (key) {
            try {
                return window.localStorage.getItem(key);
            } catch (e) {
                return null;
            }
        },
        set: function (key, value) {
            try {
                window.localStorage.setItem(key, value);
            } catch (e) {
                // nothing to do
            }
        },
        del: function (key) {
            try {
                window.localStorage.removeItem(key);
            } catch (e) {
                // nothing to do
            }
        }
    };

    function uuid() {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // One uid per console, kept for good: the account lists devices by it,
    // and a fresh one on every launch would fill the device limit.
    var deviceUid = store.get("ftv.device");
    if (!deviceUid) {
        deviceUid = uuid();
        store.set("ftv.device", deviceUid);
    }

    // Same layout as the Android app's "<kind>;<os version>;<os>;<model>;
    // <brand>;<app version>;".
    var DEVICE_INFO = "TV PS5;1;" + PLATFORM + ";PlayStation 5;sony;" +
        APP_VERSION + ";";

    var session = {
        token: store.get("ftv.token"),
        profileUid: store.get("ftv.profile")
    };

    /* --------------------------------------------------------------- http */

    function ApiError(status, code, url) {
        this.name = "ApiError";
        this.status = status;
        this.code = code || ("HTTP_" + status);
        this.url = url;
        this.message = this.code + (status ? " (" + status + ")" : "");
    }
    ApiError.prototype = Object.create(Error.prototype);

    function encodeQuery(params) {
        var parts = [];
        Object.keys(params).forEach(function (key) {
            var value = params[key];
            if (value === undefined || value === null) {
                return;
            }
            if (Array.isArray(value)) {
                value.forEach(function (v) {
                    parts.push(key + "[]=" + encodeURIComponent(v));
                });
            } else {
                parts.push(key + "=" + encodeURIComponent(value));
            }
        });
        return parts.join("&");
    }

    function headers() {
        var h = {
            "Authorization": BASIC,
            "API-DeviceUid": deviceUid,
            "API-DeviceInfo": DEVICE_INFO,
            "Accept": "application/json"
        };
        if (session.token) {
            h["API-Authentication"] = session.token;
        }
        if (session.profileUid) {
            h["API-ProfileUid"] = session.profileUid;
        }
        return h;
    }

    // Paths are relative to /api; absolute URLs (a prolong URL handed back by
    // the API) are used as they are.
    function resolve(path) {
        if (/^https?:/.test(path)) {
            return path;
        }
        if (path.indexOf("/api/") === 0) {
            path = path.substring(4);
        }
        return BASE + path;
    }

    /*
     * The server's clock.
     *
     * A jailbroken console's clock cannot be trusted -- one was found over an
     * hour fast -- and "what is on now" depends on it. The API exposes its
     * Date header to CORS, and the Android app keeps its own time from it the
     * same way. Second resolution is plenty for an EPG.
     */
    var clockOffset = 0;

    function syncClock(res) {
        var date = res.headers && res.headers.get("Date");
        var server = date ? Date.parse(date) : NaN;
        if (isFinite(server)) {
            clockOffset = server - Date.now();
        }
    }

    function now() {
        return Date.now() + clockOffset;
    }

    function request(method, path, opts) {
        opts = opts || {};
        var url = resolve(path);
        var query = opts.query || {};
        if (!/[?&]platform=/.test(url) && !query.platform) {
            query.platform = PLATFORM;
        }
        var qs = encodeQuery(query);
        if (qs) {
            url += (url.indexOf("?") < 0 ? "?" : "&") + qs;
        }

        var h = headers();
        var init = {method: method, headers: h, credentials: "omit"};
        if (opts.body !== undefined) {
            h["Content-Type"] = "application/json";
            init.body = JSON.stringify(opts.body);
        }

        return fetch(url, init).then(function (res) {
            syncClock(res);
            return res.text().then(function (text) {
                var json = null;
                try {
                    json = text ? JSON.parse(text) : null;
                } catch (e) {
                    json = null;
                }
                if (!res.ok) {
                    var err = new ApiError(res.status, json && json.code, url);
                    if (session.token && res.status === 401) {
                        // The token was revoked (signed out elsewhere, device
                        // removed from the account). Drop it so the UI asks
                        // again instead of failing every call.
                        forget();
                    }
                    throw err;
                }
                return json;
            });
        }, function () {
            // fetch only rejects on network failure or a CORS refusal.
            throw new ApiError(0, "NETWORK", url);
        });
    }

    function list(json) {
        if (Array.isArray(json)) {
            return json;
        }
        return (json && json.items) || [];
    }

    /* --------------------------------------------------------------- auth */

    function signedIn() {
        return !!session.token;
    }

    function forget() {
        session.token = null;
        session.profileUid = null;
        store.del("ftv.token");
        store.del("ftv.profile");
    }

    // The login response is the subscriber record; its token is the session.
    // The profile uid is needed for profile-scoped calls, and the Android app
    // takes it from the profile list by the subscriber's active profile id.
    function adopt(subscriber) {
        if (!subscriber || !subscriber.token) {
            throw new ApiError(0, "NO_TOKEN");
        }
        session.token = subscriber.token;
        store.set("ftv.token", session.token);

        return request("GET", "/subscribers/profiles").then(function (json) {
            var profiles = list(json);
            var active = profiles.filter(function (p) {
                return p.id === subscriber.activeProfileId;
            })[0] || profiles[0];
            if (active && active.uid) {
                session.profileUid = active.uid;
                store.set("ftv.profile", active.uid);
            }
            return subscriber;
        }, function () {
            return subscriber;
        });
    }

    // TV-style pairing: the console asks for a code anonymously, the
    // subscriber confirms it at PAIR_URL, and until then logging in with the
    // code answers DEVICE_CODE_EXPIRED_OR_NOT_EXISTS.
    function requestCode() {
        return request("POST", "/subscribers/devices/codes", {body: {}});
    }

    function loginWithCode(code) {
        return request("POST", "/subscribers/login", {
            body: {code: code, rememberMe: true}
        }).then(adopt);
    }

    function loginWithPassword(email, password) {
        return request("POST", "/subscribers/login", {
            body: {
                email: email,
                auth: {type: "PASSWORD", value: password},
                rememberMe: true
            }
        }).then(adopt);
    }

    /*
     * Phone login, FreeTV's main way in. Sending the number texts a code and
     * opens a login attempt identified by a uuid; the code (or the link in
     * the same SMS) confirms it, after which the attempt hands out a one-off
     * token that logs in like any other.
     *
     * The number goes in as typed, ten digits starting 05 -- the Android
     * app does no rewriting either.
     */
    function sendSms(msisdn) {
        return request("POST", "/int/subscribers/msisdn/token", {
            body: {msisdn: msisdn}
        });
    }

    function verifySms(uuid, code) {
        return request("PUT", "/int/subscribers/msisdn/token", {
            body: {code: code, uuid: uuid}
        });
    }

    // Answers MSISDN_LOGIN_CODE_EXPIRED_OR_NOT_EXISTS until the attempt is
    // confirmed.
    function loginWithSms(uuid) {
        return request("GET", "/int/subscribers/msisdn/token", {
            query: {uuid: uuid}
        }).then(function (res) {
            return request("POST", "/subscribers/login", {
                body: {
                    appVersion: APP_VERSION,
                    rememberMe: true,
                    token: res.token,
                    tokenType: "SUBSCRIBER"
                }
            });
        }).then(adopt);
    }

    function logout() {
        var done = function () {
            forget();
        };
        if (!session.token) {
            return Promise.resolve();
        }
        return request("POST", "/subscribers/logout").then(done, done);
    }

    function detail() {
        return request("GET", "/subscribers/detail");
    }

    /* ------------------------------------------------------------ catalog */

    function lives() {
        return request("GET", "/products/lives", {
            query: {firstResult: 0, maxResults: 200}
        }).then(list);
    }

    // The programme service takes minutes and a numeric offset and refuses
    // anything else -- no seconds, no "Z", no colon in the offset.
    function epgTime(date) {
        function pad(n) {
            return (n < 10 ? "0" : "") + n;
        }
        return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) +
            "-" + pad(date.getUTCDate()) + "T" + pad(date.getUTCHours()) +
            ":" + pad(date.getUTCMinutes()) + "+0000";
    }

    function programmes(liveIds, since, till) {
        var chunks = [];
        for (var i = 0; i < liveIds.length; i += 20) {
            chunks.push(liveIds.slice(i, i + 20));
        }
        return Promise.all(chunks.map(function (ids) {
            return request("GET", "/products/lives/programmes", {
                query: {since: epgTime(since), till: epgTime(till), liveId: ids}
            }).then(list, function () {
                return [];
            });
        })).then(function (parts) {
            return [].concat.apply([], parts);
        });
    }

    function sections(label, limit) {
        return request("GET", "/products/sections/" + (label || "main"), {
            query: {elementsLimit: limit || 30}
        }).then(list);
    }

    function serial(id) {
        return request("GET", "/products/vods/serials/" + id);
    }

    function seasons(serialId) {
        return request("GET", "/products/vods/serials/" + serialId + "/seasons")
            .then(list);
    }

    function episodes(serialId, seasonId) {
        return request("GET", "/products/vods/serials/" + serialId +
                       "/seasons/" + seasonId + "/episodes").then(list);
    }

    function vod(id) {
        return request("GET", "/products/vods/" + id);
    }

    // Image URLs come scheme-relative, with a template that takes the size.
    function image(item, ratio, width, height) {
        var set = item && item.images && (item.images[ratio] ||
                                         item.images["16x9"]);
        var img = set && set[0];
        if (!img) {
            return "";
        }
        var url = img.templateUrl
            ? img.templateUrl.replace(/\{width:\d+\}/, width)
                .replace(/\{height:\d+\}/, height)
            : img.url;
        url = absolute(url);
        return israel(url) || url;
    }

    // A frame grab of what a live channel is showing. Every channel carries
    // one and flags coverAsSlides, which is the official app's cue to show it
    // in place of the logo.
    function slide(item, width, height) {
        if (!item || item.coverAsSlides === false) {
            return "";
        }
        var img = item.slides && item.slides["16x9"] && item.slides["16x9"][0];
        if (!img) {
            return "";
        }
        var url = img.templateUrl
            ? img.templateUrl.replace(/\{width:\d+\}/, width)
                .replace(/\{height:\d+\}/, height)
            : img.url;
        url = absolute(url);
        return israel(url) || url;
    }

    /* ----------------------------------------------------------- playback */

    // Episodes play as MOVIE (EPISODE is refused); a programme is a catch-up
    // recording and plays by its recording id rather than its own.
    function videoType(item) {
        if (item.type === "LIVE") {
            return "LIVE";
        }
        if (item.type === "PROGRAMME") {
            return "CATCHUP";
        }
        return "MOVIE";
    }

    function productId(item) {
        return item.type === "PROGRAMME" ? item.programRecordingId : item.id;
    }

    function absolute(src) {
        return /^\/\//.test(src) ? "https:" + src : src;
    }

    /*
     * FreeTV's CloudFront hosts pick an edge by where the DNS resolver is,
     * not where the viewer is. A console on a far-away DNS server -- common
     * on jailbroken consoles, to keep Sony's updates out -- ends up streaming
     * from another continent: a resolver in Texas meant Houston, ~1.5 s to
     * the first byte and ~4 Mbps, where Tel Aviv gives 0.05 s and 60+.
     *
     * Redge, whose platform FreeTV runs on, serves the same paths from its
     * own CDN at a fixed Israeli address, whatever resolver is asked.
     */
    var ISRAEL_CDN = "https://r-rest.il.cdn-redge.media/";
    var CLOUDFRONT = /^https:\/\/(?:d1zqtf09wb8nt5\.cloudfront\.net|d2cnhvalvet16a\.cloudfront\.net|vod\.freetv\.tv)\//;

    function israel(url) {
        return url && CLOUDFRONT.test(url) ? url.replace(CLOUDFRONT, ISRAEL_CDN) : null;
    }

    /*
     * Resolve an item to something a player can open.
     *
     * Signed in, the player configuration comes first: it opens a video
     * session (which has to be kept alive and closed) and carries the CDN
     * query parameters live streams need -- a live manifest without them
     * answers 401. Catch-up and many VOD sources are open without it.
     *
     * The playlist lists sources by format. When it also carries a drm block
     * the streams are encrypted: HLS there is FairPlay, which the console
     * lacks, so DASH with PlayReady is the way in.
     */
    function playback(item) {
        var type = videoType(item);
        var id = productId(item);
        var path = "/products/" + id + "/videos";

        // A refused configuration (ITEM_NOT_PAID, say) is not the end: open
        // sources may still play. It is kept, since it explains the failure
        // better than a 401 from the CDN would if nothing does.
        var configError = null;
        var config = session.token
            ? request("GET", path + "/player/configuration",
                      {query: {videoType: type}})["catch"](function (err) {
                          configError = err;
                          return null;
                      })
            : Promise.resolve(null);

        return config.then(function (cfg) {
            return request("GET", path + "/playlist", {query: {videoType: type}})
                .then(function (playlist) {
                    var info = describe(playlist || {}, cfg || {}, type);
                    info.configError = configError;
                    return info;
                }, function (err) {
                    throw configError || err;
                });
        });
    }

    function describe(playlist, cfg, type) {
        var params = {};
        var qp = (cfg.playlist && cfg.playlist.source &&
                  cfg.playlist.source.queryParams) || {};
        Object.keys(qp).forEach(function (key) {
            var v = qp[key];
            params[key] = v && typeof v === "object" ? v.value : v;
        });
        var extra = encodeQuery(params);

        function first(kind) {
            var list = playlist.sources && playlist.sources[kind];
            if (!list || !list[0] || !list[0].src) {
                return null;
            }
            var url = absolute(list[0].src);
            return extra ? url + (url.indexOf("?") < 0 ? "?" : "&") + extra
                : url;
        }

        // A tokenised source only goes to the Israeli CDN once the account
        // has been granted it -- the player configuration answered -- and
        // never for a viewer who is not entitled to it.
        var entitled = !!(cfg.videoSession || cfg.playlist);

        function nearby(kind) {
            var list = playlist.sources && playlist.sources[kind];
            if (!list || !list[0] || (list[0].tokenInPath && !entitled)) {
                return null;
            }
            return israel(first(kind));
        }

        var drm = playlist.drm || null;
        var vs = cfg.videoSession || {};

        return {
            type: type,
            live: type === "LIVE",
            hls: first("HLS"),
            dash: first("DASH"),
            mp4: first("MP4"),
            hlsNear: nearby("HLS"),
            dashNear: nearby("DASH"),
            mp4Near: nearby("MP4"),
            encrypted: !!drm,
            licence: drm ? {
                playready: drm.PLAYREADY && drm.PLAYREADY.src,
                widevine: drm.WIDEVINE && drm.WIDEVINE.src
            } : null,
            session: {
                id: vs.videoSessionId || null,
                prolongUrl: vs.prolongUrl || null,
                prolongInterval: vs.prolongInterval || 0
            },
            raw: {playlist: playlist, config: cfg}
        };
    }

    /*
     * Keep a video session open while it plays, the way the web player does:
     * PUT the prolong URL on its interval, DELETE it on the way out. Returns
     * the function that closes it. Sessions count against the account's
     * concurrent stream limit, so the close matters.
     */
    function holdSession(info, onLost) {
        var url = info.session.prolongUrl;
        if (!url) {
            return function () {};
        }
        var every = Math.max(30, info.session.prolongInterval || 60) * 1000;
        var timer = setInterval(function () {
            request("PUT", url)["catch"](function (err) {
                if (err.status >= 400 && err.status < 500) {
                    clearInterval(timer);
                    if (onLost) {
                        onLost(err);
                    }
                }
            });
        }, every);
        var closed = false;
        return function () {
            if (closed) {
                return;
            }
            closed = true;
            clearInterval(timer);
            request("DELETE", url)["catch"](function () {});
        };
    }

    return {
        PAIR_URL: PAIR_URL,
        ApiError: ApiError,
        headers: headers,
        signedIn: signedIn,
        requestCode: requestCode,
        loginWithCode: loginWithCode,
        loginWithPassword: loginWithPassword,
        sendSms: sendSms,
        verifySms: verifySms,
        loginWithSms: loginWithSms,
        logout: logout,
        detail: detail,
        lives: lives,
        programmes: programmes,
        sections: sections,
        serial: serial,
        seasons: seasons,
        episodes: episodes,
        vod: vod,
        image: image,
        slide: slide,
        playback: playback,
        holdSession: holdSession,
        now: now,
        clockOffset: function () {
            return clockOffset;
        },
        deviceUid: function () {
            return deviceUid;
        }
    };
}());
