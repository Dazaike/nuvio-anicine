# Nuvio AniCine

Movies, TV and anime for Nuvio through the embed hosts behind [anicine.sbs](https://anicine.sbs). **A plain plugin** (`providers/anicine.js`), no addon, no cookie, no setup.

## How anicine.sbs works (recon)

anicine.sbs is a Next.js shell that has **no streams of its own**. Its watch page (`/watch/movie/<tmdb>-<slug>`, `/watch/tv/<tmdb>-<slug>`, `/watch/anime/<mal>-<slug>`) only puts an `<iframe>` on one of a fixed list of third-party embed hosts, taken from a table in its JS bundle (chunk `8567-*.js`):

| Kind | Addressed by | Embed hosts the site lists |
|---|---|---|
| movie | TMDB id | play.xpass.top, vidstuck.cc, vidly.pro, vidbolt.xyz, vumeto.xyz, player.vidmario.net, embed.vidrift.net, embed.filmu.in, vaplayer.ru, zxcstream.cc, cinemaos.tech |
| tv | TMDB id + season + episode | the same hosts |
| anime | **MAL id** + episode number (absolute inside that MAL entry) + `sub`/`dub` | megaplay.buzz, tryembed.us.cc, vidly.pro, flixera.co, megavid.buzz, zokoanime.video, vidhawk.buzz, mikaza.buzz (Hindi), embed.animetvplus.site |

The site itself is not behind a Cloudflare challenge for plain Node (`curl`/`fetch` with a normal User-Agent get 200), and it offers two key-free helper endpoints that the plugin reuses: `/api/tmdb?path=/tv/<id>` (TMDB proxy) and `/api/anilist?action=search&q=<title>` (AniList/MAL search, gives `idMal`).

So the plugin skips the shell and asks the embed hosts directly. Each host has its own chain (all reproduced from plain Node `fetch`, none needs a cookie):

| Host | Chain | Needs |
|---|---|---|
| **vidbolt.xyz** | `GET /api/resolve?type=&id=&season=&episode=&only=<server>` returns the stream JSON with the HLS URL | `Referer: https://vidbolt.xyz/` on the API **and** on the HLS (the API answers 403 with `Referer: anicine.sbs` or none; the Orion CDN answers 403 on the variant playlist without a Referer) |
| **vumeto.xyz** | `GET /embed/<path>` -> `<meta name="vumeto-session">` -> `GET /_player/resolve?...&provider=` with `X-Vumeto-Session` and the embed page as `Referer` | HLS (Astra) needs nothing. The MP4 proxy (Flux) only answers when the request carries `Sec-Fetch-Dest: video` and a Referer, see below |
| **embed.vidrift.in** | `GET /api/boot/<path>` with `x-embed-parent: https://7movies.ac` returns signed BigBang (HEVC/H.264 fMP4 up to 2160p), Evion and Orion URLs. The `.net` mirror is behind a Cloudflare challenge, `.in` is not. With `anicine.sbs` as parent the fields come back empty | nothing on BigBang/Evion; Orion needs `Referer: https://embed.vidrift.in/` |
| **vidstuck.cc** | tmdb details -> `POST /backend/andromeda` (CryptoJS-AES `meow` field) -> `GET /backend/servers/berkas` (AES-encrypted links) | nothing |
| **zxcstream.cc** | same player family as vidstuck, `GET /backend_/sources/alatreon` | nothing |
| **vaplayer.ru** | `va_src.php` -> embed page `CONFIG.apiToken` -> `streamdata.vaplayer.ru/api.php` (encrypted blob + wasm URL) -> decrypt with the embed's own WASM (re-implemented as a small i32 interpreter because QuickJS has no WebAssembly) -> `generate.php` JWT | `Referer: https://nextgencloudfabric.com/` on the HLS |
| **embed.filmu.in / vidly.pro** | one page fetch, sealed RSC payload decoded in plain JS (the player's XOR cipher) | nothing, but the hosts **hang** (see below), so Filmu is off by default |
| **zokoanime.video** | `GET /stream/mal/<mal>/<ep>/<sub|dub>`, page carries `window.__P` (base64 + XOR) with the master and VTT subtitles | `Referer: https://zokoanime.video/` |
| **megaplay.buzz** | page `data-id` -> `/stream/getSources?id=` -> AES-256-CBC (constant key/IV from the player JS) -> master | `Referer: https://megaplay.buzz/` |
| **tryembed.us.cc** | page (cookie, ticket) -> `POST /api/bootstrap` -> AES -> `/s/<token>.m3u8` -> inner signed URL | the inner URL needs no headers |
| **embed.animetvplus.site** | page -> `state-data.src` (uqload embed) -> p,a,c,k,e,d unpack -> signed master | no Referer (a foreign Referer returns a decoy 720p stub), sub only |

## Plugin or addon? Plugin.

Nothing forces a server. No host binds links to a fixed IP other than the player's, every required header is a plain `Referer` that Nuvio sends from the stream's `headers`, there is no URL-extension problem, and the one piece that needs WebAssembly (vaplayer) was ported to plain JS (`src/21-vaplayer.js`, a tiny i32 wasm interpreter, about 40 ms in QuickJS). Links that are IP-bound (vaplayer's JWT is described as IP-bound; I did not test from a second IP) work because the playing device requests them.

## Add the plugin in Nuvio

Settings, Plugins (Local Scrapers), add this manifest URL:

```
https://raw.githubusercontent.com/Dazaike/nuvio-anicine/main/manifest.json
```

GitHub raw caches for about 5 minutes. No cookie or login is needed.

## What it returns

First entry is always **"AniCine - Auto (Best)"**: the highest quality H.264/MPEG-TS or fMP4 HLS stream found (never HEVC, never a header-spoofing MP4). For anime the Auto entry is the first anime server in your chosen audio (sub by default). After it come the individual servers, named after the real server (`Vidbolt Orion`, `Vumeto Astra`, `Zoko ZokoAnime`, `Megaplay MegaPlay`, ...), with `quality` set to `2160p`/`1080p`/... and an English subtitle (up to two) where the host provides one. Results are cached per title for 5 minutes.

Servers run **one after another** on purpose: Nuvio's `fetch` is a blocking native call (`PluginRuntime.kt` `__native_fetch`), so `Promise.all` would not parallelise on the device anyway. Each slow server has a cut-off based on the elapsed time (no new server starts after about 8-12 s), so a typical call is 5-12 s, and nothing starts after 32 s.

### Movies and TV (TMDB id)

Order: Vidbolt Orion, Vumeto Astra, Vidrift, Vidbolt Callisto (H.265), Vidstuck Berkas, Zxcstream Alatreon, VaPlayer, Vumeto Flux (MP4). Titles with several audio languages (Callisto, Vidrift Orion, Vidly Prism) list only the English/original ones unless you turn on "List every audio language".

### Anime

Nuvio sends the TMDB id, season and episode. The plugin asks the site's TMDB proxy for the title; if it is Japanese animation (genre 16, origin JP) it maps `(season, episode)` to a **MAL id and an episode number inside that MAL entry** using the episode's air date and AniList start dates. That handles three numbering styles:

- long shows with TMDB absolute numbering, for example One Piece: TMDB S21 starts at episode 892 -> MAL 21, ep 892;
- one MAL entry per season or cour (Demon Slayer S3 -> MAL 47778, Attack on Titan S3 part 2 -> MAL 38524 with episodes renumbered from 1);
- the TMDB season that is really a later MAL entry (Frieren S1E30 -> MAL 59978 "Season 2" ep 2).

If TMDB lists the season but not that episode number (for example One Piece S21E100: season 21 only has episodes 892-1088), the plugin returns `[]` instead of guessing. Anime films are mapped to their MAL movie. Settings gear: **Anime audio** = Subtitled (default), Dubbed, or Both.

Anime servers used: Zoko (1 fetch), Megaplay (2), TryEmbed (3), AnimeTVPlus (2, sub only). Mikaza (Hindi MP4) is only used with "List every audio language". The generic TMDB servers run afterwards and usually add English-dub/other-audio streams for the same title.

## Settings gear

`hasSettings: true`. Fields: anime audio (select), list HEVC servers, list header-dependent servers (Flux), list every audio language, try slow servers (Filmu).

## Test it

```
npm install                       # only for crypto-js (Nuvio provides it at runtime)
node test/node-test.js            # one round of the matrix, every returned stream is verified
ROUNDS=3 PAUSE=600 node test/node-test.js   # three rounds, then one more after a 10 minute pause
VERBOSE=1 ONLY=Spirited node test/node-test.js   # one case with per-server timings
node test/quickjs-load.js         # loads the provider into a real QuickJS (needs quickjs-emscripten, see the header of the file)
```

`test/node-test.js` runs the provider inside a `vm` context without `Buffer`, `TextEncoder`, `crypto`, `process`, `WebAssembly` or `setTimeout`, serialises `fetch` like the device and caps response bodies at 1 MB, then checks each returned stream from Node: HLS master -> variant -> first segment bytes (`0x47` sync or `ftyp`/`moof`, AES-128 playlists decrypted with their key), MP4 by a 1 MB Range request and magic bytes.

## Test results (2026-11-20, from Node, not on a real Nuvio)

Cases: movies (Fight Club 550, **Spider-Man: Brand New Day 969681** as the recent-movie case, The Odyssey 2026, Plan 9 from Outer Space 1957, Albino Farm 2009), an anime film (Spirited Away), TV (Breaking Bad S1E1, Supernatural S15E20, The Simpsons S34E10), anime TV (One Piece S21E892 = absolute episode 892, Demon Slayer S3E5, Frieren S1E10, Attack on Titan S3E15), plus a title the site does not have (TMDB 99999999 as movie and as tv), a TMDB episode that does not exist (One Piece S21E100) and garbage ids. `ROUNDS=3 PAUSE=600`: three rounds back to back, then a fourth after a 10 minute pause.

| title | streams | servers | per-stream result (master > variant > first segment, or MP4 range bytes) | getStreams | subs |
|---|---|---|---|---|---|
| movie 550 Fight Club | 9 | Auto, Vidrift BigBang, Vumeto Astra, Vidbolt Orion, Vidstuck Berkas, Zxcstream Alatreon V, VaPlayer JustHD #1, VaPlayer JustHD #2, Vidrift Orion · Original | 9/9 verified | 8663 ms | 2 |
| movie 969681 Spider-Man: Brand New Day (2026) | 11 | Auto, Vumeto Astra, Vidbolt Orion, Vidrift BigBang, Vidstuck Berkas, Zxcstream Alatreon V, VaPlayer JustHD #1, VaPlayer JustHD #2, Vidrift Orion · Original, Vidrift Orion · Malayalam, Vidrift Orion · Kannada | 11/11 verified | 6381 ms | 1 |
| movie 1368337 The Odyssey (2026) | 8 | Auto, Vumeto Astra, Vidrift BigBang, Vidbolt Orion, Vidstuck Berkas, Zxcstream Alatreon V, Vidbolt Callisto, Vidrift Orion · Original | 8/8 verified | 8097 ms | 3 |
| movie 10513 Plan 9 from Outer Space (1957) | 3 | Auto, VaPlayer JustHD #1, VaPlayer JustHD #2 | 3/3 verified | 6533 ms | 0 |
| movie 25693 Albino Farm (2009, obscure) | 3 | Auto, VaPlayer JustHD #1, VaPlayer JustHD #2 | 3/3 verified (separate run, see below) | 6875 ms | 0 |
| movie 129 Spirited Away (anime film) | 8 | Auto, TryEmbed Astra Server, AnimeTVPlus AnimeTVPlus (Uqload), Zoko ZokoAnime, Megaplay MegaPlay, Vidbolt Orion, Vidrift BigBang, Vumeto Astra | 8/8 verified | 9783 ms | 8 |
| tv 1396 Breaking Bad S1E1 | 11 | Auto, Vidbolt Orion, Vidrift BigBang, Vidstuck Berkas, Vumeto Astra, Vidrift Evion, Zxcstream Alatreon V, VaPlayer JustHD #1, VaPlayer JustHD #2, Vidbolt Callisto, Vidrift Orion · Original | 11/11 verified | 9545 ms | 4 |
| tv 1622 Supernatural S15E20 | 7 | Auto, Vumeto Astra, Vidrift BigBang, Zxcstream Alatreon V, VaPlayer JustHD #1, VaPlayer JustHD #2, Vidbolt Callisto | 7/7 verified | 6869 ms | 2 |
| tv 456 The Simpsons S34E10 | 5 | Auto, Zxcstream Alatreon V, VaPlayer JustHD #1, VaPlayer JustHD #2, Vidrift Orion · Original | 5/5 verified | 7709 ms | 0 |
| anime tv 37854 One Piece S21E892 (abs 892) | 5 | Auto, TryEmbed Astra Server, AnimeTVPlus AnimeTVPlus (Uqload), Zoko ZokoAnime, Megaplay MegaPlay | 5/5 verified | 8556 ms | 6 |
| anime tv 37854 One Piece S21E100 (TMDB has no such episode) | 0 | [] | [] | 141 ms | 0 |
| anime tv 85937 Demon Slayer S3E5 | 10 | Auto, TryEmbed Beta Server, AnimeTVPlus AnimeTVPlus (Uqload), Zoko ZokoAnime, Megaplay MegaPlay, Vidrift BigBang, Zxcstream Alatreon V, VaPlayer JustHD #1, VaPlayer JustHD #2, Vidbolt Callisto | 10/10 verified | 8246 ms | 10 |
| anime tv 209867 Frieren S1E10 | 11 | Auto, TryEmbed Beta Server, AnimeTVPlus AnimeTVPlus (Uqload), Zoko ZokoAnime, Megaplay MegaPlay, Vidrift BigBang, Zxcstream Alatreon V, VaPlayer JustHD #1, VaPlayer JustHD #2, Vidrift Orion · Original, Vidrift Orion · English | 11/11 verified | 8057 ms | 8 |
| anime tv 1429 Attack on Titan S3E15 (part 2) | 10 | Auto, TryEmbed Astra Server, AnimeTVPlus AnimeTVPlus (Uqload), Zoko ZokoAnime, Zxcstream Alatreon V, VaPlayer JustHD #1, VaPlayer JustHD #2, Vidrift BigBang, Vidrift Orion · Original, Vidrift Orion · English | 10/10 verified | 9096 ms | 4 |
| unknown movie 99999999 | 0 | [] | [] | 406 ms | 0 |
| unknown tv 99999999 S1E1 | 0 | [] | [] | 353 ms | 0 |
| garbage id "abc" | 0 | [] | [] | 0 ms | 0 |
| garbage id "-5" tv | 0 | [] | [] | 0 ms | 0 |

(Round 4, after the 10 minute pause. Every row's streams were checked by bytes: HLS master, variant, first segment is MPEG-TS `0x47` or fMP4 `ftyp/moof`. Full per-stream lines for that round are in `test/RESULTS.md`.)

**Pass count: 68/72 case runs as logged (4 rounds x 18 cases), 382/382 returned streams verified (no individual stream failure, no hang and no throw inside the logged matrix).** The 4 logged misses: 3 are Albino Farm in rounds 2-4, which the test then wrongly expected to be empty (the three VaPlayer streams it returns are real, verified separately: master > 270p variant > segment, 3/3; the test expectation is now "empty or all verified"), and 1 is Plan 9 in round 2, where VaPlayer (its only source) answered with an over-cap captcha and the plugin correctly returned `[]`. Counting Albino Farm as the pass it is: **71/72**. The 600 s re-run passed 17/18 (the same Albino Farm expectation) with 98/98 streams verified, so cached/signed URLs and the host chains survive a 10 minute gap. A last small change (non-English "Server · Language" entries hidden by default) was made after that run and re-checked on Spider-Man only (10/10 streams verified).

Timing per `getStreams` call, fetches serialised like the device: about 5.5 to 11.6 s over all 72 runs (median about 8 s); garbage ids return in 0 ms and unknown ids in about 0.4 s. Nothing went over 15 s.

Compared with the site's own player in BrowserOS neo: **Spider-Man: Brand New Day** (the site lists it, 2026-07-29): the Vumeto player resolves it and starts a 2 h 25 min stream, and the plugin returns streams for it. **Albino Farm**: the Vumeto player says "Unable to load this stream", while the plugin finds a 270p stream on VaPlayer, so the hosts do differ per title. **Frieren S1E10**: Zoko's own page loads a 24:30 stream.

Real QuickJS check (`test/quickjs-load.js`, quickjs-emscripten): the file parses, `getStreams`/`onSettings` exist, none of Buffer/TextEncoder/process/WebAssembly/setTimeout is referenced at load, a garbage id resolves `[]`, and a real id with a failing `fetch` resolves `[]` (no rejection).

## Refresh steps

- `src/00-core.js` holds the orchestration, mapping and the two inline hosts (vidbolt, vumeto); the other `src/NN-*.js` files are the per-host modules. `node tools/build.js` concatenates them into `providers/anicine.js` (the only file Nuvio loads). Edit `src/`, rebuild, bump the version in `manifest.json`.
- If a host stops working run its probe in a browser (BrowserOS neo) and compare with the chain table above. Constants that can rotate: vidly's `VIDLY_KEY`, vidstuck/zxcstream `VS_KEY`, megaplay's AES key/IV, zoko's XOR key `otaku-embed-v1`, vidrift's required `x-embed-parent`, vaplayer's WASM (fetched fresh per request, so nothing to refresh).

## Known limits

- **Not run on a real Nuvio/ExoPlayer.** Everything was judged from Node (`fetch`, bytes, segments). Playback in the app, seeking, and how ExoPlayer treats each stream (for example the headers on Orion/Zoko/Megaplay, or fMP4 vs TS) is untested.
- **Hosts sometimes stall.** A `fetch` on the device has no timeout of its own (no `setTimeout` for an abort timer, OkHttp read timeout is 30 s) and Nuvio kills the whole call at 45 s. The plugin runs servers one at a time and stops starting new ones after fixed elapsed times (about 8-12 s for the slow tail, hard stop 32 s), but one host that hangs for 30 s after 14 s of work could still push a call past 45 s. During my runs I saw individual CDN requests (Orion variant playlist, Astra master, a Flux MP4) abort after 20 s in my verifier a handful of times; the provider calls themselves never hung.
- **Filmu and Vidly hang**: `embed.filmu.in` answered 7 of 8 page requests with no response for 20 s at the time I measured it, and `vidly.pro` took 13-40 s per page. Filmu is only used with "Try slow or flaky servers"; Vidly is not used at all (the Filmu module is the same app).
- **Gated, not used**: `play.xpass.top`, `player.vidmario.net`, `cinemaos.tech` and `embed.vidrift.net` return a Cloudflare managed challenge (403, `cf-mitigated: challenge`) on every dynamic path from plain Node, including their APIs; a `cf_clearance` cookie bound to the solving browser's UA would be needed. Vidrift is reached through its `.in` mirror, which has no such rule.
- **Dead or unsuitable, not used**: Flixera (HLS segments are AES ciphertext behind a 70-byte PNG header, a custom loader would be needed), Megavid (its media host `s-90.megavid.se` does not resolve), Vidhawk (Cloudflare blocks Node's TLS fingerprint, its resolve API takes about 50 s), Vidstuck Atlas/Andromeda/Milkyway/Ursa and Zxcstream Atlas/Ursa/Valstrax (DASH only, 403/52x on segments, or no streams), Vidbolt Luna/Vega/Quantum/Quasar (always `null` or 9-18 s), Vumeto Vega/Kumo/aniembed (503).
- **VaPlayer rate cap**: its embed returns an over-cap captcha page after about 7 resolves in a burst (cleared within 21 s). The plugin then gets nothing from it. VaPlayer streams are 720p or lower for TV, sometimes the only source for thin-catalogue movies, and have no subtitles.
- **Vumeto Flux** (MP4 proxy) only answers requests that carry `Sec-Fetch-Dest: video`, `Sec-Fetch-Mode: no-cors`, `Sec-Fetch-Site: same-origin` and the embed page as Referer; the plugin sends those as stream headers. It takes about 1-6 s to resolve, can return nothing for new titles and stalled once in my range check, so it is behind the "slow or flaky servers" toggle and never chosen by Auto.
- **HEVC servers** (Vidbolt Callisto, Vidrift BigBang on some titles and Orion, Vidly Prism) are listed after the H.264 ones and never picked by Auto (Best); older TVs may not decode them. Vidrift BigBang is HEVC on some titles: it is flagged from the master's codec when the module can tell, otherwise it is listed as plain HLS.
- **Anime mapping is a heuristic.** It uses TMDB episode air dates against AniList start dates. The mapping output (not playback) was checked for One Piece (S21E892, S1E1), Demon Slayer (S1E1, S3E5), Attack on Titan (S1E1, S3E15, S4E5), Frieren (S1E10, S1E30 -> Season 2 ep 2), Naruto S1E1 and Naruto Shippuden S1E1, not for every show. Specials (TMDB season 0) skip the mapping and use the generic servers only. A wrong match returns the wrong episode from the anime servers, not an error.
- **Sub/dub and hard subs not verified.** Sub and dub are separate streams on Zoko/Megaplay/TryEmbed; I did not listen to any dub, and could not prove which sub streams are hard-subbed (Bleach 269 on Megaplay and TryEmbed has no soft subtitle track, which suggests hard subs). Subtitles are only attached when a host provides an English track (Megaplay, Zoko, TryEmbed, Vidrift BigBang, Vidbolt Callisto/Orion, Vumeto Orion).
- **Expiry.** Signed links last from about 4 hours (VaPlayer JWT, AnimeTVPlus) to a day (BigBang) to about 7 days (Vidly Prism); the plugin caches a title for 5 minutes only. Lifetime of Zoko's and Megaplay's masters, and of Vidstuck/Zxcstream's unsigned playlists, was not measured. TryEmbed's inner URL was still valid after 10 minutes.
- **IP binding** was not tested from a second IP for any host. VaPlayer's JWT is described as IP-bound by its own endpoint.
- **Episode not yet released / not on the hosts**: returns `[]` (unknown TMDB ids and anime episodes TMDB does not list return `[]` after one or two requests).
- Third-party hosts, constants and Cloudflare rules change without notice; re-run `node test/node-test.js` after any change.
