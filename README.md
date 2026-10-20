# Kuling

Weather for Norway on the **Nokia 8110 4G** (KaiOS 2.5 / GerdaOS), using the same open data as Yr.
It's built for a 240x320 screen and a keypad.

![Kuling](app/icons/icon112x112.png)

## Features

- **Now**: temperature, conditions, wind with a direction arrow, rain over the next hour,
  and the next four hours
- **Rain radar for the next 90 minutes** (MET nowcast), in 5-minute steps: "Rain in ~20 min",
  "Rain stops in ~10 min"
- **Hours**: hour by hour for 48 hours, with temperature, precipitation and wind
- **Days**: 9 days, with high/low, total precipitation, strongest wind and a daytime symbol
- **Places**: search any Norwegian place name (Kartverket), or use **My location** (GPS, named after
  the municipality). Up to 9 places, on number keys 1-9.
- Polite caching: forecasts are reused until MET's `Expires` time and revalidated with
  `If-Modified-Since`, which saves data and follows the API terms
- Shows the last saved forecast when offline

## Keys

| Screen | Key | Action |
|---|---|---|
| Weather | Left / Right | Switch Now / Hours / Days |
| | Up / Down | Scroll |
| | 1-9 | Switch to saved place 1-9 |
| | SoftLeft | Places |
| | SoftRight | Refresh (only fetches if MET has published newer data) |
| Places | Up / Down, Enter | Pick a place, My location, or Search |
| | SoftRight | Remove the selected place |
| | SoftLeft / Back | Back |
| Search | Type, then Enter | Search (T9 works; `#` switches input mode) |
| | Down / Up, Enter | Pick a result to add it |

## Data and credits

- Forecasts: [MET Norway](https://api.met.no/) Locationforecast 2.0 and Nowcast 2.0,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Shown in the app as "Data: MET Norway".
- Place names and municipalities: [Kartverket](https://www.kartverket.no/) via ws.geonorge.no,
  CC BY 4.0.
- Weather symbols: [metno/weathericons](https://github.com/metno/weathericons), MIT, © Yr.
  The license is in `app/weather/LICENSE`.

Kuling is an independent hobby project. It is not affiliated with Yr, NRK or MET Norway.

### API terms

MET requires an identifying User-Agent, caching per `Expires`, at most 4 decimals in coordinates,
and modest traffic. The app sets `User-Agent: kuling/1.0 https://github.com/hanzhe` (possible
because the app is privileged and uses `systemXHR`). It also rounds coordinates and caches as
described above. MET allows direct calls from low-volume apps. A wider release should go through a
caching proxy instead (see their terms of service).

## Certificates: making api.met.no work on a 2016 phone

Out of the box, Kuling showed **"No connection"** on the 8110, while place search and other apps
worked. The phone log (`adb logcat`) explained it:

```
api.met.no:443 uses an invalid security certificate.
Error code: SEC_ERROR_UNKNOWN_ISSUER
```

### Cause

`api.met.no` uses a GÉANT certificate issued by HARICA:

```
*.api.met.no
  <- GEANT TLS RSA 1
  <- HARICA TLS RSA Root CA 2021   (cross-signed, sent by the server)
  <- Hellenic Academic and Research Institutions RootCA 2015
```

The phone runs Gecko 48 with a 2016 NSS and a 2016 list of built-in roots. That list has
*HARICA RootCA 2011* but not *RootCA 2015*, so the chain cannot reach a trusted root. Plain HTTP is no
way around it, because MET redirects to HTTPS. Kartverket (DigiCert) and the radio streams use roots
the phone already knows.

### Fix: trust HARICA RootCA 2015 in the phone's NSS database

Current Firefox, Chrome and macOS already trust this root (valid until 2040). Adding it brings the
phone in line with a modern browser for this one CA. It is trusted for websites only.

1. **Get the genuine root.** It was taken from macOS's `/etc/ssl/cert.pem` and cross-checked against
   curl's Mozilla-derived `cacert.pem`. Both give SHA-256
   `A0:40:92:9A:02:CE:53:B4:AC:F4:F2:FF:C6:98:1C:E4:49:6F:75:5E:6D:45:FE:0B:2A:69:2B:CD:52:52:3F:36`.
   `openssl verify` confirmed that MET's served chain validates against it.
2. **Find the database b2g really uses.** `/proc/<b2g pid>/fd` shows
   `/data/b2g/mozilla/<profile>.default/cert9.db` and `key4.db` (SQLite NSS databases).
3. **Add the certificate** with Mozilla's tools (`brew install nss`, then
   `certutil -A -t "C,,"`), working on copies pulled while b2g is stopped (`adb shell stop b2g`).
4. **First surprise: trust format.** NSS 3.131 stores trust as a PKCS#11 3.2 `CKO_TRUST` object
   (class `0x0b`). Gecko 48's NSS only reads the legacy `CKO_NSS_TRUST` (class `0xce534353`), so the
   root was present but untrusted. The record was rewritten in the legacy format, mirroring the
   working *ISRG Root X1* record already in the database: server-auth `CKT_NSS_TRUSTED_DELEGATOR`,
   other uses `CKT_NSS_VALID_DELEGATOR`, plus the certificate's SHA-1 and MD5 hashes.
5. **Second surprise: signed trust.** It still had no effect. Tracing NSS's PKCS#11 calls
   (`NSS_DEBUG_PKCS11_MODULE`) showed the trust lookup returning nothing, although SQLite matched the
   row. NSS signs "authenticated attributes" (trust values, cert hashes) and ignores unsigned ones.
   The signatures sit in `key4.db`'s `metaData` table as `sig_cert_<object id>_<attribute>`:
   ```
   pass_key = SHA1(global_salt || password)        # empty password on this phone;
                                                   # global_salt = metaData['password'].item1
   key      = PBKDF2-HMAC-SHA256(pass_key, salt, iterations=1, 32 bytes)
   mac      = HMAC-SHA256(key, BE32(object id) || BE32(attribute type) || value)
   stored   = DER: PBMAC1 { PBKDF2 { salt, 1, 32, hmacWithSHA256 }, hmacWithSHA256 } + OCTET STRING mac
   ```
   A short Python implementation of this reproduced **all 14 existing ISRG signatures byte for
   byte** before anything was written. It then signed the seven attributes of the new trust record.
6. **Verify before pushing.** On the local copies, `certutil -L` shows the root as `C,c,c`.
   `vfychain -pp -u 1` reports *"Chain is good!"* for MET's chain and for a Let's Encrypt control chain.
7. **Push and restart.** The script first checked that the phone's databases had not changed since
   they were copied, backed both up on the phone, pushed `cert9.db` + `key4.db`, then ran
   `adb shell start b2g`. Kuling loaded forecasts right after.

### Script: `scripts/certs/add_root.py`

The steps above are automated, and the script refuses to push unless every check passes:

```sh
brew install nss    # certutil + vfychain
# Kuling's root, from the macOS trust store (also in curl's cacert.pem):
security find-certificate -a -p -c "Hellenic Academic and Research Institutions RootCA 2015" \
  /System/Library/Keychains/SystemRootCertificates.keychain > harica2015.pem

# 1. rehearse on copies (phone untouched): pull cert9.db, key4.db, pkcs11.txt into ./nssdb first
python3 scripts/certs/add_root.py harica2015.pem \
  --sha256 A0:40:92:9A:02:CE:53:B4:AC:F4:F2:FF:C6:98:1C:E4:49:6F:75:5E:6D:45:FE:0B:2A:69:2B:CD:52:52:3F:36 \
  --dry-run ./nssdb
# 2. for real: stops b2g, works on copies, checks, backs up both DBs on the phone, pushes, restarts
python3 scripts/certs/add_root.py harica2015.pem --sha256 A0:40:...:3F:36
```

The script:

- refuses a root whose SHA-256 fingerprint doesn't match `--sha256`
- refuses to sign unless it reproduces every signature already in `key4.db`, so a master password or
  a different format stops it
- refuses to push unless NSS lists the root as a trusted CA, and unless `--chain LEAF INTER...`
  validates with `vfychain` (when given)
- can be re-run safely: it replaces the root's trust record instead of adding a second one

`scripts/certs/nsssig.py` holds the signing code and is unit tested in `tests/test_nsssig.py`. The
script was tested end to end on copies of this phone's original databases. The first, manual fix on
the phone encoded the HMAC algorithm with NULL parameters, which NSS also accepts. The script
writes NSS's exact encoding.

### Backups and undo

The original and intermediate states are kept on the phone in
`/data/b2g/mozilla/<profile>.default/`:

| File | State |
|---|---|
| `cert9.db.bak-1792531491` | original, before any change |
| `cert9.db.bak-modern-1792531810` | root added, trust in the new (unreadable) format |
| `cert9.db.bak-presign-1792532299`, `key4.db.bak-presign-1792532299` | legacy trust, not yet signed |

To undo: `adb shell stop b2g`, copy the original `cert9.db` back (and the `key4.db` backup), then
`adb shell start b2g`.

### Notes

- This is a per-phone change to the trust store. It does not ship with the app. Another 8110 needs
  the same fix, or a caching proxy for `api.met.no` on a host whose certificate the phone trusts.
  MET recommends a proxy for apps anyway.
- The signatures are an integrity check under an empty password, not a lock against the owner. Get
  them wrong and NSS just ignores the trust (or, at worst, the store fails to load until restored
  from the backup).
- The same applies to any other site using a CA newer than 2016 that is missing from the phone. The
  Let's Encrypt roots (ISRG X1/X2) were already in this GerdaOS phone's database, stored the same
  way (legacy trust record plus signatures, added before this project), which is why those sites
  work.

## Requirements

- Nokia 8110 4G (or another KaiOS 2.5 phone) with **root adb**
- The HARICA RootCA 2015 trusted on the phone (see [Certificates](#certificates-making-apimetno-work-on-a-2016-phone))
- `adb`, Python 3, Node 18+ (tests only), `zip`

## Build and install

```sh
npm test                  # unit tests: app (node, real MET/Kartverket fixtures) + cert signing (python)
npm run build             # -> dist/application.zip
npm run install-phone     # push, register, grant permissions, restart the phone UI
npm run uninstall-phone
```

`install.py` reads the app id and type from `app/manifest.webapp`. It backs up `webapps.json` and
`permissions.sqlite` on the phone, writes the permission rows itself (hand-registered apps don't
get them automatically), and restarts b2g. The phone UI reloads in about 20-30 seconds.

Permissions:

- `systemXHR` (privileged): requests without CORS limits, and with a real User-Agent
- `geolocation`: My location

## Project layout

```
app/
  manifest.webapp
  index.html, style/app.css
  js/symbols.js    symbol id -> description (generated from metno/weathericons legend.csv)
  js/forecast.js   pure: parse MET data, hour/day rows, nowcast text
  js/places.js     pure: saved places, Kartverket results
  js/data.js       network + cache (Expires / If-Modified-Since)
  js/views.js      rendering
  js/main.js       state, screens, keys
  weather/         MET weather symbols (SVG)
  icons/           app icons, generated by scripts/make_icons.py
scripts/           build, icons, install, uninstall
scripts/certs/     add_root.py + nsssig.py: trust a new root CA on the phone (see Certificates)
tests/             node --test, with fixtures
```

All app code is ES5, because the phone runs Gecko 48.

## License

MIT for the code. Weather symbols are MIT © Yr (see `app/weather/LICENSE`).
