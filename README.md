# FreeTV for PS5

An unofficial 10-foot UI for [FreeTV](https://web.freetv.tv), the Israeli
streaming service, for jailbroken PS5s. It is a web app in the style of
[ps5-payload-dev/tv4play](https://github.com/ps5-payload-dev/tv4play). An
install payload copies it to the console and puts a FreeTV icon on the Media
tab. The console's browser runs it from `http://localhost:8080`, which
[websrv](https://github.com/ps5-payload-dev/websrv) serves.

> [!NOTE]
> FreeTV is geo-locked to Israel. The console needs an Israeli IP.

How this was built, and how to port the next app the same way:
[PS5-APP-PORTING-PLAYBOOK.md](PS5-APP-PORTING-PLAYBOOK.md).

## What works

- **Home**: the same rows as the FreeTV home page. That covers channels,
  sports, kids, series, movies and catch-up.
- **Channels**: every live channel, with what's on air now from the EPG.
- **Series**: seasons and episodes.
- **Playback**: live TV, catch-up, movies and episodes.
  - Clear streams play through hls.js, then Shaka (DASH), then the native
    player.
  - Encrypted titles play as DASH + PlayReady through Shaka. PlayReady is the
    only DRM the PS5 browser offers.
- **Sign in**:
  - With your phone number, the same way as the official apps: FreeTV texts
    you a code, and you type it in or tap the link in the SMS.
  - With a pairing code, like FreeTV's smart-TV apps: the console shows a
    6-digit code and you confirm it at <https://web.freetv.tv/watch-on-tv>.
  - With email and password (the server may demand a captcha).

Signed out, some channels (for example ערוץ 12) and catch-up still play.
Everything else needs an account.

Not done yet: search, favourites, continue watching, the full EPG grid,
profile switching, parental PIN.

## Controls

| Button   | Browsing                                | Playback                    |
|----------|-----------------------------------------|-----------------------------|
| D-pad    | Move. Right at the edge goes to the menu | Left/Right seek ±10 s, Up/Down next/previous channel or episode |
| Cross    | Open / play                             | Play / pause                |
| Circle   | Back                                    | Stop                        |
| Square   | Reload the view                         | Restart the stream          |
| Triangle | Technical info overlay                  | Technical info overlay      |

TV remote keys (HDMI-CEC) also work: channel up/down, play/pause, stop,
rewind and fast-forward, and Guide (opens Channels).

## Install

The console needs a jailbreak with the ELF loader (`elfldr`, port 9021) and
`websrv` running. Then, on a Mac:

```sh
brew install llvm@18 socat
# PS5 payload SDK: https://github.com/ps5-payload-dev/sdk/releases
export PS5_PAYLOAD_SDK=$HOME/ps5-dev/ps5-payload-sdk
export LLVM_CONFIG=/opt/homebrew/opt/llvm@18/bin/llvm-config

make                                # builds freetv-install.elf
make install PS5_HOST=192.168.1.50  # your PS5's IP
```

The installer prints `Install successful`, and FreeTV appears on the Media
tab. Open it, go to **חשבון** (Account), enter your phone number and press
**שלחו לי קוד** (send me a code).

The title ID is `BREW10972`. It must be unique on the console and must match
in `Makefile` and `sce_sys/param.json`.

The home-screen background comes from `sce_sys/pic0.dds`: 3840×2160, BC7
(DXGI 98), one mip level, the same layout games use. The installer only
registers a background when a `.dds` is present; a `pic0.png` on its own is
ignored.

## Developing on a computer

```sh
make serve    # http://localhost:8080
```

Open <http://localhost:8080> in Chrome. The arrow keys, Enter, Escape and F1
(Triangle) work like the pad. It has to be `localhost:8080`: FreeTV's API
echoes the page's origin back for CORS, and that is also the origin the
console uses. On a PC, encrypted titles go through Widevine instead of
PlayReady.

## How it works

FreeTV runs on Redge Media's RedGalaxy platform. The API calls were read out
of the official Android app (`tv.freetv.mobile.android`, React Native) and
the web.freetv.tv front end. All of it is in `webapp/freetv.js`:

| What                 | Call |
|----------------------|------|
| Every request        | `Authorization: Basic` (the app's own key), `API-DeviceUid`, `API-DeviceInfo` |
| Signed-in requests   | `API-Authentication: <token from login>`, `API-ProfileUid` |
| Home rows            | `GET /api/products/sections/main?elementsLimit=N` |
| Channels             | `GET /api/products/lives` |
| EPG                  | `GET /api/products/lives/programmes?since=YYYY-MM-DDTHH:mm+0000&till=…&liveId[]=…` |
| Series               | `/api/products/vods/serials/{id}`, `…/seasons`, `…/seasons/{sid}/episodes` |
| Playback session     | `GET /api/products/{id}/videos/player/configuration?videoType=LIVE\|MOVIE\|CATCHUP` |
| Sources + DRM        | `GET /api/products/{id}/videos/playlist?videoType=…` |
| PlayReady license    | `/api/products/{id}/drm/playready?…` (URL comes in the playlist) |
| Phone login          | `POST /api/int/subscribers/msisdn/token {msisdn}` (sends the SMS, returns a `uuid`), then `PUT …/msisdn/token {code, uuid}`, then `GET …/msisdn/token?uuid=` gives a token, then `POST /api/subscribers/login {token, tokenType:"SUBSCRIBER"}` |
| Pairing code         | `POST /api/subscribers/devices/codes`, then poll `POST /api/subscribers/login {code}` |

### Streaming from Israel, whatever the DNS

FreeTV's streams sit on CloudFront, which picks the edge closest to the DNS
resolver, not the viewer. Jailbroken consoles often use a remote DNS server to
block Sony updates. One in Texas sent the PS5 to Houston: about 1 s before the
first byte and about 4 Mbps, so 1080p fell back to 540p.

The app now asks Redge's own CDN (`r-rest.il.cdn-redge.media`, a fixed Israeli
address) first. It serves the same paths, and on that console delivered
40–50 Mbps with a 0.1 s first byte. The CloudFront URL stays as the fallback.

A token-protected stream is only sent there after FreeTV's player configuration
has granted it to the signed-in account. Content the account isn't entitled to
always goes through FreeTV's own URL.

All requests carry `platform=BROWSER`. Episodes play as `videoType=MOVIE`. A
catch-up programme plays by its `programRecordingId` as `CATCHUP`. The DASH
manifests end in `Manifest.ism`, so they have to be loaded with an explicit
`application/dash+xml` type, or Shaka treats them as Smooth Streaming.

## Troubleshooting

Press **Triangle** anywhere. The overlay shows:

- the device ID and whether you are signed in;
- what the browser supports (MSE, HEVC, PlayReady);
- each playback attempt: the source URL, which engine was tried, and the
  error (hls.js details, Shaka error names, HTTP status).

## License

GPLv3+. `webapp/input.js`, `main.c` and `Makefile` come from John Törnblom's
ps5-payload-dev/tv4play. Bundled: hls.js 1.5.20 (Apache-2.0), Shaka Player
4.12.6 (Apache-2.0), Heebo font (SIL OFL 1.1).

This project is not affiliated with FreeTV. It uses your own FreeTV account.
