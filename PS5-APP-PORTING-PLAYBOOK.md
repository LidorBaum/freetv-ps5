# Porting an Android streaming app to a jailbroken PS5: playbook

This playbook covers how the FreeTV (Israeli streaming) app was brought to a jailbroken PS5 in one
session: the research, the reverse engineering, the build setup, the dead ends and the fixes. Use it
as the template for the next app. This repo is the working project. Machine-specific details kept
out of the public repo are in `PRIVATE.md`, which git ignores and which exists only locally.

Written: 2026-10-21. Console: PS5 system software 8.20, jailbroken, ELF loader on port 9021.

---

## 1. The short version

1. **An Android app can't run on a PS5.** There is no Android runtime. A "port" is a new client that
   talks to the same backend as the Android app.
2. **Pick the app model by DRM:**
   - **Web app served by websrv** (HTML/JS in the PS5's WebKit). It is the only route that can play
     DRM content: the console's browser has **PlayReady** through EME. Use this for streaming services.
   - **Native app** (C/C++ with ps5-payload-sdk, OpenGL, FFmpeg). Faster UI, but it can't decrypt
     DRM. Fine for open streams (IPTV, Stremio-like apps).
3. **Reverse the Android app.** Unzip the APK, find the JS bundle or dex, then pull out the API base,
   auth headers, endpoints and stream formats. Probe the live API from your own machine with curl.
4. **Fork the tv4play web-app layout** (`ps5-payload-dev/tv4play`): `webapp/`, an installer `main.c`,
   and `sce_sys/param.json`. Swap in your own API client.
5. **Build on macOS** with `llvm@18` and the prebuilt ps5-payload-sdk. Deploy with `socat` to port
   9021. websrv must be running on the console.
6. **Test in desktop Chrome** at `http://localhost:8080` first, then on the console. Ship the console's
   logs to your Mac over the LAN. The console has no devtools.

---

## 2. Research: where everything came from

### 2.1 PS5 jailbreak landscape (as of October 2026)

| Thing | What it is | Where |
|---|---|---|
| Relapse | Browser + kernel exploit chain, firmware 7.00–13.60, not persistent | [Tom's Hardware](https://www.tomshardware.com/video-games/playstation/new-ps5-relapse-jailbreak-enables-homebrew-and-switch-emulation-but-is-hamstrung-by-rapidly-changing-firmware-revisions-jailbreak-unlocks-firmware-13-60-but-newer-games-already-demand-firmware-14-00), [GBAtemp](https://gbatemp.net/threads/relapse-ps5-kernel-exploit-brings-homebrew-to-firmware-7-00-13-60.684829/) |
| etaHEN / kstuff | Homebrew enablers loaded after the exploit (fake-signed apps, etc.) | community |
| **elfldr** | ELF payload loader, listens on **TCP 9021** | [ps5-payload-dev/elfldr](https://github.com/ps5-payload-dev/elfldr) |
| **websrv** | Web server on the console, **port 8080**. Serves `/fs/...` (the console filesystem), launches homebrew. Hosts our web app. | [ps5-payload-dev/websrv](https://github.com/ps5-payload-dev/websrv) |
| ps5-payload-sdk | Clang toolchain and libs for payloads. Prebuilt zip, works on macOS. | [ps5-payload-dev/sdk](https://github.com/ps5-payload-dev/sdk) |

Firmware 14.00+ had no public exploit when this was written.

### 2.2 Reference ports studied

| Repo | Model | What it taught |
|---|---|---|
| [ps5-payload-dev/tv4play](https://github.com/ps5-payload-dev/tv4play) | websrv web app | **The template.** Install payload, `param.json` + `webAppUri`, PlayReady through Shaka, hls.js fallback, controller input (`input.js`), "served from localhost" for CORS, `downloadDataSize` for localStorage |
| [ps5-payload-dev/plutotv](https://github.com/ps5-payload-dev/plutotv) | websrv web app | Native WebKit HLS has **no audio** when audio is a separate rendition, so use hls.js. Console exposes PlayReady, not Widevine or FairPlay. |
| [ps5-payload-dev/svtplay](https://github.com/ps5-payload-dev/svtplay) | websrv web app | Same family |
| [Sp9nky/unofficial-stremio-ps5-port](https://github.com/Sp9nky/unofficial-stremio-ps5-port) | native | Native route: payload SDK, ps5-homebrew-ui, OpenGL, FFmpeg, packaged as `.ffpfsc` for ShadowMountPlus |
| [LoZazaMastro/Stremio-Plus](https://github.com/LoZazaMastro/Stremio-Plus) | native | Fork of the above with a torrent engine |
| [onlykappa/ps5-react](https://github.com/onlykappa/ps5-react), [bartando/ps5-react](https://github.com/bartando/ps5-react) | native React | React/JSX runtime for native homebrew. An option for native UIs. |
| ps5-homebrew-ui (mirrors: `MyLuxy/overdrive-deps`, `abhi245y/ps5-homebrew-ui`) | native UI kit | Original repo is gone; use a mirror |
| [ps5-payload-dev/tvhp](https://github.com/ps5-payload-dev/tvhp), [jtplay](https://github.com/ps5-payload-dev/jtplay) | native players | TVHeadend player and media player; worth reading for native playback (not studied here) |
| [blackbearreloaded/ps5-homebrew-catalog](https://github.com/blackbearreloaded/ps5-homebrew-catalog), [homebrew.page](https://homebrew.page) | catalog | What exists already |

Searches that found these: "PS5 jailbreak homebrew port Stremio", `gh repo list ps5-payload-dev`,
`gh search repos ps5-react`, `gh search repos "ps5 homebrew ui"`. The `gh` CLI was more reliable
than web search for finding repos.

### 2.3 Facts about the PS5 browser (measured on system 8.20)

Logged from inside the app:

| | Value |
|---|---|
| User agent | `Mozilla/5.0 (PlayStation; PlayStation 5/8.20) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15` |
| Viewport | 1920×1080 CSS px, **devicePixelRatio 2**, so text renders at 4K. Request images at 2× size. |
| MSE / AVC / HEVC | yes / yes / yes |
| Native HLS | yes, but plays no audio from separate audio renditions. Use hls.js. |
| EME | **PlayReady yes**; Widevine no; FairPlay no |
| IntersectionObserver | present but unusable: lazy images never loaded. Use `getBoundingClientRect` checks instead. |
| localStorage | only persists if `param.json` has `downloadDataSize` |
| Clock | **was 77 minutes wrong**. Take time from the server's `Date` header. |
| CORS | normal browser rules. The page origin is `http://localhost:8080`. |

---

## 3. Reverse engineering the Android app

### 3.1 Unpack

An `.xapk` (APKPure) is a zip of split APKs plus `manifest.json`:

```sh
mkdir xapk && unzip -q App.xapk -d xapk && cat xapk/manifest.json
unzip -l xapk/<package>.apk | grep -Ei 'index.android.bundle|flutter|\.so$|assets/'
unzip -l xapk/config.arm64_v8a.apk | grep '\.so'    # native libs reveal the framework
```

Work out the framework from what's inside:

| Clue | Framework | Next step |
|---|---|---|
| `assets/index.android.bundle` + `libreactnative.so` / `libhermes.so` | React Native | Check the bundle's first bytes: plain JS (`var __BUNDLE_START_TIME__`) can be read directly. Hermes bytecode (starts `c6 1f bc 03`) needs a Hermes decompiler. |
| `libflutter.so` + `libapp.so` | Flutter | Dart AOT. Harder; network capture is easier. |
| Only `classes*.dex` | Native Android | jadx / apktool |

FreeTV was **React Native with a plain-JS bundle**, which is the best case: everything is readable.

### 3.2 Mine the bundle

Minified bundles are single giant lines, and `ugrep` hits "exceeds complexity limits" on them. Use
`tools/grep_context.py` instead:

```sh
python3 -I tools/grep_context.py bundle.js 'licenseUrl' 300 300 5
strings -n 12 bundle.js | grep -Eo 'https?://[a-zA-Z0-9._/-]+' | sort -u     # hosts
grep -oE "'/[a-z][a-zA-Z0-9_/{}.$-]{3,60}'" bundle.js | sort -u            # route-like paths
```

What to look for, and what FreeTV's bundle gave:

| Look for | FreeTV result |
|---|---|
| API base URL | `https://web.freetv.tv/api` |
| Hard-coded app credentials | `Authorization: Basic krs-freetv-prod:oht0ue5taxoo7Ii7` (an app key shared by every install, not a user secret) |
| Header names enum | `API-DeviceUid`, `API-DeviceInfo`, `API-Authentication` (session token), `API-ProfileUid`, `API-CorrelationId` |
| Env / feature flags | `isIsraelGeolockEnabled`, `isMsisdnLoginEnabled`, `isBasicEnabled` |
| Stream source formats | sources keyed `DASH` / `HLS` / `MP4` / `SS`; DRM map keyed `WIDEVINE` / `PLAYREADY` / `FAIRPLAY` |
| Login payload builders | `{email, auth:{type:"PASSWORD", value}, rememberMe}`, `{token, tokenType:"SUBSCRIBER"}` |

### 3.3 The web client is often the same backend

If the service has a website, fetch its JS bundle too. It is usually less mangled about routes:

```sh
curl -s https://web.freetv.tv/ | grep -oE '(src|href)="[^"]+"'            # find the bundle
curl -s -o web.js 'https://web.freetv.tv/static/js/index.js'
python3 -I -c "import re;t=open('web.js').read();[print(k,'=',v) for k,v in sorted(set(re.findall(r'(VUE_APP_[A-Z0-9_]+):\"([^\"]*)\"',t)))]"
```

The web client gave the playback endpoint, the player-configuration endpoint, the session
prolong/close logic, the SMS-login calls and the TV pairing page (`/watch-on-tv`). The page meta
(`og:image` on `redgalaxy-portal-fo.redlabs.pl`) also identified the platform vendor: **Redge
Media / RedGalaxy**. Other RedGalaxy services work the same way.

### 3.4 Probe the live API from your own machine

Geo-locked services (FreeTV is Israel-only) must be probed from the same country. Error codes reveal
the shapes:

```sh
U='krs-freetv-prod:oht0ue5taxoo7Ii7'
curl -s -u "$U" -H 'API-DeviceUid: <uuid>' 'https://web.freetv.tv/api/products/lives?platform=BROWSER'
curl -s -X POST -u "$U" -H 'Content-Type: application/json' -d '{}' \
     'https://web.freetv.tv/api/subscribers/login'          # -> PLATFORM_UNDEFINED: add ?platform=
```

Useful error-code breadcrumbs from this session: `PLATFORM_UNDEFINED`,
`SUBSCRIBER_INVALID_LOGIN_REQUEST`, `DEVICE_CODE_EXPIRED_OR_NOT_EXISTS` (meaning the server
understood the `{code}` body), `DATE_TIME_FORMAT_INVALID` (keep trying formats; `YYYY-MM-DDTHH:mm+0000`
won), `ITEM_NOT_PAID`, `AUTHENTICATION_REQUIRED`, `MSISDN_LOGIN_CODE_EXPIRED_OR_NOT_EXISTS`.

**Always check CORS early.** It decides whether a web app can call the API directly:

```sh
curl -s -D- -o /dev/null -H 'Origin: http://localhost:8080' -u "$U" \
     'https://web.freetv.tv/api/products/lives?platform=BROWSER' | grep -i access-control
```

FreeTV echoes any origin back with credentials, so no proxy was needed. If an API refuses foreign
origins, it may still accept `localhost`: that's why tv4play serves from the console.

**Don't probe endpoints that cause side effects on real people**: SMS sending, payments. Probe with
empty or dummy bodies that fail validation.

### 3.5 FreeTV API map (RedGalaxy)

All calls need `?platform=BROWSER`, Basic auth, `API-DeviceUid` and `API-DeviceInfo`. Signed-in calls
also send `API-Authentication: <token>` and `API-ProfileUid`.

| Purpose | Call |
|---|---|
| Home rows | `GET /products/sections/main?elementsLimit=N` |
| Live channels | `GET /products/lives?firstResult=0&maxResults=200` |
| EPG | `GET /products/lives/programmes?since=YYYY-MM-DDTHH:mm+0000&till=…&liveId[]=…` |
| Series | `GET /products/vods/serials/{id}`, `…/seasons`, `…/seasons/{sid}/episodes` |
| Player session | `GET /products/{id}/videos/player/configuration?videoType=LIVE\|MOVIE\|CATCHUP` returns `videoSession {videoSessionId, prolongUrl, prolongInterval}` and `playlist.source.queryParams` |
| Sources + DRM | `GET /products/{id}/videos/playlist?videoType=…` |
| PlayReady license | URL given in the playlist's `drm.PLAYREADY.src` |
| Keep session alive | `PUT prolongUrl` every `prolongInterval` s; `DELETE prolongUrl` on exit |
| Phone login | `POST /int/subscribers/msisdn/token {msisdn}` returns `{uuid}`; `PUT …/msisdn/token {code, uuid}`; `GET …/msisdn/token?uuid=` returns `{token}`; then `POST /subscribers/login {token, tokenType:"SUBSCRIBER", rememberMe:true}` |
| TV pairing | `POST /subscribers/devices/codes` returns `{code, expiresAt}`; user confirms at `/watch-on-tv`; poll `POST /subscribers/login {code}` |

Quirks:
- Episodes play as `videoType=MOVIE`.
- A catch-up programme plays by its `programRecordingId` as `CATCHUP`.
- DASH URLs end in `Manifest.ism`: load them in Shaka with mime type `application/dash+xml`, or it
  parses them as Smooth Streaming (`4046 MSS_INVALID_XML`).
- Every live channel has `slides["16x9"]`, a live frame grab, plus `coverAsSlides: true`. That's how
  the official app shows live thumbnails.

---

## 4. Toolchain setup (macOS, Apple Silicon)

```sh
brew install llvm@18 socat
mkdir -p ~/ps5-dev && cd ~/ps5-dev
gh release download -R ps5-payload-dev/sdk -p ps5-payload-sdk.zip     # v0.45 used here
unzip -q ps5-payload-sdk.zip -d ~/ps5-dev                             # -> ~/ps5-dev/ps5-payload-sdk

export PS5_PAYLOAD_SDK=$HOME/ps5-dev/ps5-payload-sdk
export LLVM_CONFIG=/opt/homebrew/opt/llvm@18/bin/llvm-config
```

- The SDK doesn't need `/opt` or sudo. Any directory works if `PS5_PAYLOAD_SDK` points at it.
- Sanity check: build `tv4play` unchanged with `make`. The output is an x86-64 ELF.
- macOS has no `timeout` command. Use `socat -T <idle-seconds>` instead.

### Getting payloads onto the console

```sh
nc -z -G 3 <ps5-ip> 9021 && echo elfldr up         # loader running?
nc -z -G 3 <ps5-ip> 8080 && echo websrv up         # websrv running?

# websrv is required for web apps; load it after every reboot / re-jailbreak:
gh release download -R ps5-payload-dev/websrv -p websrv-ps5.elf
socat -T 8 - TCP:<ps5-ip>:9021 < websrv-ps5.elf

# your installer (prints its stdout back to you):
socat -T 30 - TCP:<ps5-ip>:9021 < freetv-install.elf     # or: make install PS5_HOST=<ip>
```

`make install` uses the SDK's `prospero-deploy`, which needs `socat`.

---

## 5. The web-app project layout

```
freetv-ps5/
  Makefile               TITLE_ID, build, install, serve; LOG_SINK=… for dev builds
  main.c                 install payload: embeds every file below and registers the title
  sce_sys/
    param.json           titleId, titleName, webAppUri, downloadDataSize, category
    icon0.png            512×512 tile icon
    pic0.png/.dds        home-screen background (the .dds is what's used, see §7)
    pic1.png/.dds        launch art
  webapp/
    index.html app.css   10-foot UI shell
    config.js            generated by make: window.FREETV_LOG_SINK
    freetv.js            API client (everything service-specific)
    input.js             pad/remote/focus handling (from tv4play, unchanged)
    app.js               views, navigation, player
    lib/                 vendored hls.js 1.5.20, shaka-player 4.12.6
    fonts/               Heebo WOFF (Hebrew + Latin, SIL OFL)
  tools/                 mkdds.py, mkart.py, logsink.py, grep_context.py
```

### 5.1 `param.json`

```json
{
    "applicationCategoryType": 66048,
    "titleId": "BREW10972",
    "localizedParameters": { "defaultLanguage": "en-US", "en-US": { "titleName": "FreeTV" } },
    "downloadDataSize": 256,
    "webAppUri": "https://tinyurl.com/5n6c86jf/fs/user/app/BREW10972/index.html"
}
```

- `applicationCategoryType: 66048` puts the tile on the **Media** tab.
- `titleId` must be unique on the console. Use `BREW` + 5 digits, and use the same value in the
  Makefile.
- `webAppUri`: the tinyurl redirects to `http://localhost:8080/` (path appended), meaning websrv on
  the console. The reference apps all do this; presumably the field wants an https URL.
- `downloadDataSize`: without it, localStorage writes succeed but are thrown away.

### 5.2 What the installer does (`main.c`)

1. `sceAppInstUtilInitialize()`, then uninstall any old copy.
2. Remount `/system_ex` writable. Write `/system_ex/app/<ID>/eboot.bin` (empty) and
   `sce_sys/param.json`.
3. Write the web app and `sce_sys` art to `/user/app/<ID>/` from assets embedded with `.incbin`
   (`INCASSET` macro).
4. Register the title with `sceAppInstUtilAppInstallTitleDir` (resolved by NID `Wudg3Xe3heE`). If
   that can't be resolved, fall back to `sceAppInstUtilAppInstallAll`.

Once installed, the tile keeps working after reboots, **as long as websrv is running** (it serves the
files).

---

## 6. Development loop

### 6.1 Desktop first

```sh
make serve        # serves webapp/ on http://localhost:8080
```

Use exactly `localhost:8080`, the same origin as on the console, so CORS behaves the same. Arrow
keys, Enter, Escape and F1 act as the pad. On a PC, encrypted titles go through Widevine instead of
PlayReady. Everything else is the same code path.

**Chrome DevTools MCP** drove the automated tests: load the page, dispatch `keydown` events, check
`video.currentTime` / `videoWidth`, count `waiting` events, screenshot. This caught a real bug
before it reached the console (the `.ism` mime type).

### 6.2 Logs from the console to your Mac

The console has no devtools. The fix is a dev-only log channel:

```sh
python3 -I tools/logsink.py 8099 ps5.log &               # on the Mac (firewall off or allowed)
make install LOG_SINK=http://<mac-ip>:8099/log PS5_HOST=<ps5-ip>
tail -f ps5.log
```

- `make` writes `webapp/config.js` with the sink URL. `app.js`'s `diag()` batches lines and POSTs
  them as `text/plain`, a simple CORS request with no preflight.
- A plain `make` leaves the sink empty, so normal builds send nothing.
- `logsink.py` also serves `GET /blob?mb=N` (zeros, CORS-enabled) for LAN download speed tests.
- The **Triangle** overlay shows the same lines on the TV.

Log at least: UA, viewport + DPR, MSE/codec/EME capabilities, image load counts, each playback
attempt (engine, URL, error), chosen rendition, decoded resolution, and per-segment timing.

### 6.3 Reading the console's files

websrv exposes the filesystem read-only over HTTP. This was how the background-image problem was
found:

```sh
curl -s 'http://<ps5-ip>:8080/fs/user/appmeta/?fmt=json'
curl -s -o app.db 'http://<ps5-ip>:8080/fs/system_data/priv/mms/app.db'   # home-screen database
sqlite3 -readonly app.db "SELECT titleId, icon0Info, pic0Info FROM tbl_contentinfo;"
```

---

## 7. Home-screen art

- **icon0.png**: 512×512.
- **Background = `pic0`**, and the installer only registers it from **`pic0.dds`**. A `pic0.png`
  alone leaves `pic0Info` empty in `app.db`, and the tile shows the default background.
  - Format, copied byte for byte from a working homebrew (PS5LM): DDS + DX10 header, **DXGI 98
    (BC7_UNORM)**, 3840×2160, 1 mip, `depth=1`, `misc2=1`. File size 8,294,548.
  - `tools/mkdds.py in.png out.dds` does it (needs `pip install etcpak texture2ddecoder`; run in a
    venv). It round-trip-checks the encode with an independent decoder. etcpak's own
    `decompress_bc7` is broken.
- **pic1**: same format; launch art.
- Generating art from an **SVG logo**: draw it into a `<canvas>` in Chrome at the target size
  (measure `getBBox()` first; the viewBox may have padding), export PNGs, then convert to DDS.
  QuickLook (`qlmanage`) renders SVGs into square thumbnails and is no good for this.
- Android launcher icons max out at 192 px (432 px for the adaptive foreground). Ask for the brand's
  SVG.

---

## 8. Playback

### 8.1 Engine ladder

```
encrypted:  Shaka (DASH + PlayReady)        – console; Widevine is used on a PC
clear:      hls.js  →  Shaka (DASH)  →  native <video> HLS  →  MP4
```

Each source is tried from the fast CDN first and from the original URL second (see §9). A step
fails over to the next one on a fatal error or after 20 s without a frame.

### 8.2 hls.js settings that mattered

```js
new Hls({
    abrEwmaDefaultEstimate: 20000000, // the default assumes a slow line → starts at 540p, climbs, stalls
    testBandwidth: false,
    liveSyncDurationCount: 4,         // a bit further from the live edge = room to buffer
    autoStartLoad: false              // pick the top level in MANIFEST_PARSED, then startLoad(-1)
});
```

- **Don't call `play()` on `MANIFEST_PARSED`.** Wait on `FRAG_BUFFERED` until ≥ 6 s is buffered,
  with a 12 s safety release. That gives one buffering phase instead of "play, stall, play".
- Log `FRAG_LOADED` stats (`frag.stats.loading.start/first/end`, `total`). That's how the network
  problem in §9 was found.

### 8.3 Shaka settings that mattered

```js
player.configure({
    streaming: { bufferingGoal: 30, rebufferingGoal: 6 },
    abr: { defaultBandwidthEstimate: 20000000 },
    drm: { servers: { "com.microsoft.playready": licenceUrl, "com.widevine.alpha": wvUrl } }
});
player.getNetworkingEngine().registerRequestFilter(function (type, req) {
    if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) { /* add the service's auth headers */ }
});
player.load(url, null, "application/dash+xml");
```

Shaka error codes are opaque numbers. Map them back to names with `shaka.util.Error.Code` in the logs.

### 8.4 Sessions

If the service opens a video session (FreeTV: `videoSession.prolongUrl`), keep it alive on its
interval and `DELETE` it when playback stops. Sessions count against the account's concurrent-stream
limit.

---

## 9. The network gotcha: remote DNS on jailbroken consoles

**Symptom:** about 14 s to start, then 1080p → 720p → 540p. Each segment request waited 0.6–1.2 s
before the first byte, and four parallel downloads totalled only 5 Mbps. The PS5's own Wi-Fi was
fine: about 59 Mbps on the LAN.

**Cause:** the console used a remote DNS server in the US, a typical "block Sony
updates" setup. **CloudFront picks the edge closest to the DNS resolver**, so the PS5 streamed from
**Houston** (`iah50`) while the Mac used Tel Aviv (`tlv55`).

**How it was proven** (no console changes needed):

```sh
dig +short @<console-dns> d1zqtf09wb8nt5.cloudfront.net      # what the PS5 gets
dig +short -x <ip>                                            # → server-…iah50.r.cloudfront.net
curl --resolve d1zqtf09wb8nt5.cloudfront.net:443:<ip> -o /dev/null \
     -w '%{time_starttransfer} %{time_total}\n' <segment-url> # reproduce the slowness from the Mac
```

**Fix without touching DNS:** find the platform's own fixed-region CDN. Redge serves the same paths
from `r-rest.il.cdn-redge.media`, a single Israeli IP whatever the resolver. On the PS5: 40–50 Mbps,
first byte about 0.1 s, 1080p in about 1.5 s.

- How it was found: hostnames already present in API responses (e.g. the FairPlay `cert` URL host)
  and CDN-looking hosts in the bundles. Try the same path on each one.
- **Respect access control.** Token-protected streams only go there after the service's player
  configuration has granted them to the signed-in account. Never use an alternative host to reach
  content the account isn't entitled to.

Diagnosis order for slow playback next time:
1. Per-segment timing in the player (first byte vs transfer).
2. A local websrv file (tests the browser itself), a LAN download from the Mac (tests Wi-Fi), the CDN
   from the console.
3. The console's DNS, and which CDN edge it resolves to.

---

## 10. UI notes

- **10-foot UI:** `html { font-size: calc(11px + 0.42vw) }`, keep out of the outer 3% (overscan),
  and make focus obvious (accent ring plus scale).
- **Controller key codes** (from `input.js`): Cross 13, Circle 27, Triangle 112 (F1), Square 113 (F2),
  arrows 37–40. HDMI-CEC remote keys arrive as their own codes (ChannelUp 157 / Down 158, MediaPause
  135, Guide 216, colour keys 152–155, …).
- **Spatial navigation:** `Input.move(dir, scope, nowrap)` scores by geometry. In RTL layouts, pass
  `nowrap` so Left/Right never fall back to document order (which runs backwards in RTL).
- **Text input:** call `Input.suspend()` while an `<input>` has focus (the console's on-screen
  keyboard needs the keys), and `resume()` on blur.
- **RTL Hebrew:** `<html dir="rtl">`. Wrap times in LRM marks (`‎`). Keep the player timeline
  LTR. Format times with `Intl.DateTimeFormat(…, {timeZone: "Asia/Jerusalem"})`.
- **Fonts:** bundle a WOFF with the script you need (the console's fonts are unknown). Don't
  redistribute the app's own commercial font: FreeTV's Ploni is licensed to them. Heebo (OFL) was
  used instead.
- **Images:** load lazily by geometry (§2.3), request them at `devicePixelRatio`× size, and refresh
  live frames by preloading off-screen, then swapping, a few at a time. A refresh that fails keeps the
  old frame.

---

## 11. Login patterns seen

| Pattern | UX on a console | Notes |
|---|---|---|
| TV pairing code | Best: no typing | Console requests a code anonymously; user confirms on a phone. Find the "watch on TV" page in the web client's routes. |
| Phone + SMS OTP | Good: digits only | Copy the web client's exact calls; also poll the status, since the SMS link can confirm the login too |
| Email + password | Worst | Often captcha-protected |
| Refresh-token paste (tv4play) | Fallback | When login is bot-protected |

Prefer services whose session is a **header token** (FreeTV's `API-Authentication`) over cookies:
the page is on `localhost`, so cookies would be third-party.

---

## 12. Mistakes made and lessons learned

1. Guessed a pairing URL (`/devices/codes`) that was really an API path. **Look up web routes in the
   web client** (`path:"/watch-on-tv"`) before telling a user where to go.
2. A long-running poller kept going after its code expired. Give pollers an explicit deadline and a
   kill path.
3. IntersectionObserver lazy-loading worked in Chrome, failed on the console.
4. The installer ignored `pic0.png`. Read `app.db` to see what the home screen actually registered.
5. Swift (`swift` CLI) was broken on this Mac's Command Line Tools (module redefinition). Pure Python
   or Chrome canvas did the image work instead.
6. The console clock was off by over an hour. Never trust `Date.now()` for "what's on now".
7. "Starts low, climbs, stalls" is ABR's default behaviour, not a bug. Set the initial estimate and
   gate playback on buffer.
8. Slow streaming on a fine Wi-Fi link meant **DNS-based CDN routing**. Measure before guessing.
9. Bursts of image refreshes failed on the console. Stagger them, preload, swap.
10. The Claude Code auto-mode classifier blocked the first credentialed API probe until the user
    approved it. Ask up front when a task needs live calls with app keys.

---

## 13. Checklist for the next app

- [ ] **Firmware and jailbreak** confirmed; `elfldr` (9021) and `websrv` (8080) reachable.
- [ ] **Unpack the APK.** Identify the framework and find the bundle or dex.
- [ ] **Extract** the API base, app credentials, header names, endpoints, login flows, stream
      formats and DRM keys.
- [ ] **Fetch the web client** if one exists: routes, config, player code.
- [ ] **Probe from the service's country:** catalog, playlist, DRM block, CORS for `localhost:8080`.
- [ ] **Decide the model:** DRM means the web app with PlayReady; open streams can go either way.
- [ ] **Copy this repo.** Change `TITLE_ID` (Makefile and `param.json`), `titleName`, and the
      art. Replace `freetv.js`.
- [ ] **Art:** `icon0.png` 512², `pic0.dds` and `pic1.dds` 3840×2160 BC7 (`tools/mkdds.py`).
- [ ] **Test in Chrome** at `localhost:8080`: views, navigation, open stream, DRM up to the license
      request.
- [ ] **Install with `LOG_SINK`**, run `tools/logsink.py`, and check caps, images, playback,
      rendition and segment timing.
- [ ] **Check the CDN path from the console:** DNS, and whether there's a regional host.
- [ ] **Release build:** plain `make` (no log sink), then `socat` it to 9021.

---

## 14. Status of the FreeTV port

Done and verified on the console:
- Home rows, channels, series, catch-up, EPG ("on air now").
- Live thumbnails, with the brand art on the home screen.
- Open live channels at 1080p through the Israeli CDN, about 1.5 s to start.
- PlayReady present.

Not verified yet:
- SMS login end to end, and the shape of the login response (`token` field).
- Token-protected channels (e.g. ערוץ 9) with a session.
- Whether the PlayReady license is granted for movies.
- SPORT 5 4K's renditions and whether it decodes at 2160p.
- TV pairing completion.

Not built: search, favourites / continue-watching rows, the full EPG grid, profiles, parental PIN.
