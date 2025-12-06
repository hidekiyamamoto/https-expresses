# https-expresses.js

A Node.js HTTPS server to run all your Express apps on multiple domains, each with its own certificate (and optional static sites) using a tiny file convention.

> Short pitch: **“One HTTPS server, many Express apps, per‑domain certs.”**

## What this thing does

- Terminates HTTPS on a single port using certificates from a LetsEncrypt‑style tree (`/etc/letsencrypt/live` by default).
- Routes traffic by `Host` header to:
  - Express apps exported from `*.hts.js` files.
  - Static sites described by `*.hts.txt` files (one domain per line).
- Keeps a simple text config (`https-expresses.cfg`) listing every app/static, its directory, domains, and whether a cert is present.
- Can generate a minimal Express template file for new services.
- Optionally auto‑installs missing Node modules the first time they’re required.

Think of it as a tiny, Node‑native front door in front of all your Express apps and static folders.

## Quick start

From the `https-expresses.js` folder:

```bash
node https-expresses.js
```

On start it will:
- Print help
- Load certificates from `/etc/letsencrypt/live` (or `--cert-root`).
- Load app modules and statics from the existing `https-expresses.cfg` (see below).
- For any domain with a valid cert, add:
  - `Strict-Transport-Security`
  - `Content-Security-Policy: upgrade-insecure-requests`

Use `-h` or `--help` (or just read startup output) to see all options.

## Discovery and config

Discovery is **explicit and interactive**, not “magic on every boot”.

- **Apps**: any `*.hts.js` file that exports an async initializer returning `{ app, domains, meta? }`.
- **Statics**: any `*.hts.txt` file that lists domains, one per line. A common pattern is `config.hts.txt` inside the site root.

To (re)scan the filesystem:

```bash
node https-expresses.js --update
```

This will:

1. Walk `/` for `*.hts.js` and `*.hts.txt` (using the patterns in the config).
2. Compare the results with the existing `https-expresses.cfg`.
3. Ask you, in the terminal, whether to:
   - Add new apps/statics.
   - Remove entries that no longer exist.
   - Accept or keep changes to domain lists.
4. Rewrite `https-expresses.cfg` and exit.

Normal runs reuse the last written `https-expresses.cfg` and do **not** rescan.

### Config file format

`https-expresses.cfg` is intentionally human‑friendly, example:

```text
/hay-zen-production/firestory.it/node/firestory.hts.js
  type: express
  dir: /hay-zen-production/firestory.it/node
  domains:
    - firestory.it (cert: present)
    - www.firestory.it (cert: present)

/hay-zen-production/ilradio.org/config.hts.txt
  type: static
  dir: /hay-zen-production/ilradio.org
  domains:
    - ilradio.org (cert: present)
```

The first line is always the **absolute path** of the file; everything else is metadata that can be safely regenerated with `--update`.

## Writing an app module (`*.hts.js`)

Minimal example:

```js
// my-service.hts.js
const express = require('express');

module.exports = {
  domains: ['example.com', 'www.example.com'],
  meta: { description: 'Example service.' },
  async init() {
    const app = express();

    app.get('/healthz', (req, res) => {
      res.json({ status: 'ok' });
    });

    app.get('/', (req, res) => {
      res.send('Hello from example.com');
    });

    return { app, domains: ['example.com', 'www.example.com'] };
  },
};
```

Drop this somewhere on disk, run `node https-expresses.js --update`, say “yes” when it asks to add the module, and it’s live for its domains.

### Static sites (`*.hts.txt`)

Inside each static root (e.g. `/hay-zen-production/my-site`):

```text
# /hay-zen-production/my-site/config.hts.txt
my-site.com
www.my-site.com
```

The router will:

- Mount a tiny Express app serving that folder.
- For directory requests, try (in order): `index.html`, `index.htm`, `default.html`, `default.htm`.
- Compress responses for non‑already‑compressed content types.

## CLI overview

Most used flags:

- `--update`  
  Interactive rescan + config update, then exit.
- `--https-port <port>`  
  HTTPS port (default: `443`).
- `--cert-root <path>`  
  Cert root (default: `/etc/letsencrypt/live`).
- `--pattern <regex>`  
  App discovery pattern (default: `.*\.hts.js$`).
- `--static-pattern <regex>`  
  Static discovery pattern (default: `.*\.hts.txt$`).
- `--write-template [path]`  
  Write a ready‑to‑fill Express template (default: `template.hts.js`) and exit.

Help is printed automatically at startup so you don’t forget what’s available.

## Notes & philosophy

- No reverse proxy required if you’re happy with Node terminating TLS.
- Config is meant to be **checked into git** (minus certs), so the routing topology is reviewable.
- The design assumes you’re comfortable editing text files and saying “y/n” in a terminal. If you prefer GUIs, this probably isn’t your router.

That’s it: one process, many domains, and a simple contract for your apps and static sites.
