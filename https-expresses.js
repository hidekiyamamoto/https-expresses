'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const Module = require('module');
const readline = require('readline');
const { execSync } = require('child_process');
const { X509Certificate } = require('crypto');

// Ensure locally installed dependencies are visible when loading modules outside this directory.
const LOCAL_NODE_MODULES = path.join(__dirname, 'node_modules');
process.env.NODE_PATH = [LOCAL_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

// Default configuration
const DEFAULT_CONFIG = {
  proxyPattern: '.*\\.proxy.hts$',
  serversPattern: '.*\\.hts.js$',
  staticPattern: '.*\\.hts.txt$',
  certRoot: '/etc/letsencrypt/live',
  httpsPort: 443,
};

const CONFIG_PATH = path.join(__dirname, 'https-expresses.cfg');

let PROXY_PATTERN = new RegExp(DEFAULT_CONFIG.proxyPattern);
let SERVERS_PATTERN = new RegExp(DEFAULT_CONFIG.serversPattern);
let STATIC_PATTERN = new RegExp(DEFAULT_CONFIG.staticPattern);
let CERT_ROOT = DEFAULT_CONFIG.certRoot;
let HTTPS_PORT = DEFAULT_CONFIG.httpsPort; // Number(process.env.HTTPS_PORT || 443);

function hasWriteAccess(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function attemptInstall(moduleName) {
  if (!hasWriteAccess(process.cwd())) {
    throw new Error(
      `Cannot install missing dependency "${moduleName}" because there is no write access to ${process.cwd()}.`
    );
  }

  try {
    execSync('npm --version', { stdio: 'ignore' });
  } catch (error) {
    throw new Error(`Cannot install missing dependency "${moduleName}" because npm is not available.`);
  }

  console.log(`Auto-installing missing dependency "${moduleName}"...`);
  execSync(`npm install ${moduleName}`, { stdio: 'inherit' });
  console.log(`Dependency "${moduleName}" installed.`);
}

function shouldAutoInstall(error, request) {
  return (
    error &&
    error.code === 'MODULE_NOT_FOUND' &&
    typeof request === 'string' &&
    !request.startsWith('.') &&
    !request.startsWith('/') &&
    !request.startsWith('node:') &&
    error.message.includes(`'${request}'`)
  );
}

const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(request) {
  try {
    return originalRequire.apply(this, arguments);
  } catch (error) {
    if (shouldAutoInstall(error, request)) {
      attemptInstall(request);
      return originalRequire.apply(this, arguments);
    }
    throw error;
  }
};

function loadExternalModule(name) {
  try {
    return require(name);
  } catch (error) {
    // The patched require should already try auto-install; this is a final fallback.
    if (shouldAutoInstall(error, name)) {
      attemptInstall(name);
      return require(name);
    }
    throw error;
  }
}

const express = loadExternalModule('express');
const serveStatic = loadExternalModule('serve-static');
const compression = loadExternalModule('compression');
const { createProxyMiddleware }=loadExternalModule('http-proxy-middleware');

function buildTemplateContent() {
  return `'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');

// Domains this service will answer for. Update these to your real hostnames.
const DOMAINS = ['example.com', 'www.example.com'];

// Optional metadata shown in https-expresses summaries.
const MODULE_META = {
  description: 'Starter Express app for https-expresses.',
};

module.exports = {
  domains: DOMAINS,
  meta: MODULE_META,
  async init() {
    const app = express();

    // Core middleware
    app.use(compression());
    app.use(express.json({ limit: '5mb' }));
    app.use(express.urlencoded({ extended: false }));

    // Health endpoint
    app.get('/healthz', (req, res) => {
      res.json({ status: 'ok', service: 'template.hts.js', at: new Date().toISOString() });
    });

    // Static files (optional)
    const publicDir = path.join(__dirname, 'www-public');
    if (fs.existsSync(publicDir) && fs.statSync(publicDir).isDirectory()) {
      app.use(express.static(publicDir));
      console.log('[TEMPLATE] Serving static files from', publicDir);
    }

    // Simple home
    app.get('/', (req, res) => {
      res.send('Hello from template.hts.js');
    });

    return {
      app,
      domains: DOMAINS,
      meta: MODULE_META,
    };
  },
};
`;
}

function writeTemplateFile(destination) {
  const targetPath = path.isAbsolute(destination)
    ? destination
    : path.join(process.cwd(), destination);
  const content = buildTemplateContent();
  try {
    fs.writeFileSync(targetPath, content, 'utf8');
    console.log(`Template written to ${targetPath}`);
  } catch (error) {
    console.error(`Failed to write template to ${targetPath}: ${error.message}`);
    throw error;
  }
}

async function askYesNo(question, defaultYes = true) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} ${suffix} `, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      if (!normalized) {
        resolve(defaultYes);
        return;
      }
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--https-port':
        options.httpsPort = Number(argv[i + 1]);
        i += 1;
        break;
      case '--cert-root':
        options.certRoot = argv[i + 1];
        i += 1;
        break;
      case '--pattern':
        options.serversPattern = argv[i + 1];
        i += 1;
        break;
      case '--static-pattern':
        options.staticPattern = argv[i + 1];
        i += 1;
        break;
      case '--proxy-pattern':
        options.proxyPattern = argv[i + 1];
        i += 1;
        break;
      case '--update':
        options.update = true;
        break;
      case '--write-template': {
        const nextVal = argv[i + 1];
        if (nextVal && !nextVal.startsWith('-')) {
          options.writeTemplate = nextVal;
          i += 1;
        } else {
          options.writeTemplate = 'template.hts.js';
        }
        break;
      }
      default:
        // ignore unknown flags for now
        break;
    }
  }

  return options;
}

function applyConfiguration(overrides = {}) {
  if (overrides.serversPattern) {
    SERVERS_PATTERN = new RegExp(overrides.serversPattern);
  }

  if (overrides.staticPattern) {
    STATIC_PATTERN = new RegExp(overrides.staticPattern);
  }

  if (overrides.proxyPattern) {
    PROXY_PATTERN = new RegExp(overrides.proxyPattern);
  }

  if (overrides.certRoot) {
    CERT_ROOT = overrides.certRoot;
  }

  if (typeof overrides.httpsPort === 'number' && !Number.isNaN(overrides.httpsPort)) {
    HTTPS_PORT = overrides.httpsPort;
  }
}

function printHelp() {
  const usage = `
Usage:
  node ${path.basename(__filename)} [options]

Options:
  --update                  Interactive rescan: add/remove modules/statics and update domains, then exit
  -h, --help                Show this help message
  --https-port <port>       HTTPS port to listen on (default: ${DEFAULT_CONFIG.httpsPort})
  --cert-root <path>        Directory containing certificate folders (default: ${DEFAULT_CONFIG.certRoot})
  --pattern <regex>         Regex for auto-loading server modules (default: ${DEFAULT_CONFIG.serversPattern})
  --static-pattern <regex>  Regex for auto-loading static definitions (default: ${DEFAULT_CONFIG.staticPattern})
  --write-template [path]   Write a starter template file (default path: template.hts.js) and exit

What it does:
  - Discovers Express apps from files matching the pattern anywhere under / (use --update to refresh config).
  - Discovers static site definitions from files matching --static-pattern anywhere under / (use --update to refresh config).
  - Auto-loads certificates from --cert-root and configures SNI.
  - Routes HTTPS traffic by Host header to the matching Express app.
`;

  console.log(usage.trim());
}

function walkMatchingFiles({ root = '/', pattern }) {
  const matches = new Set();
  const skipDirs = new Set(['node_modules', '.git', '.hg', '.svn']);
  const stack = [path.normalize(root)];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // skip unreadable dirs
      continue;
    }

    entries.forEach((entry) => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          stack.push(fullPath);
        }
        return;
      }
      if (entry.isFile() && pattern.test(entry.name)) {
        matches.add(path.normalize(fullPath));
      }
    });
  }

  return Array.from(matches);
}

function discoverServerModules() {
  return walkMatchingFiles({ root: '/', pattern: SERVERS_PATTERN }).map((absolutePath) => ({
    absolutePath,
    displayName: path.basename(absolutePath),
  }));
}

function discoverStaticFiles() {
  return walkMatchingFiles({ root: '/', pattern: STATIC_PATTERN }).map((absolutePath) => ({
    absolutePath,
    displayName: path.basename(absolutePath),
  }));
}
function discoverProxyFiles() {
  return walkMatchingFiles({ root: '/', pattern: PROXY_PATTERN }).map((absolutePath) => ({
    absolutePath,
    displayName: path.basename(absolutePath),
  }));
}

async function loadServerDescriptor(modulePath) {
  const rawExport = require(modulePath);

  let initializer;
  let initializerContext;

  if (typeof rawExport === 'function') {
    initializer = rawExport;
  } else if (rawExport && typeof rawExport === 'object' && typeof rawExport.init === 'function') {
    initializer = rawExport.init;
    initializerContext = rawExport;
  } else if (rawExport && typeof rawExport === 'object' && typeof rawExport.initialize === 'function') {
    initializer = rawExport.initialize;
    initializerContext = rawExport;
  } else {
    throw new Error(
      `Module ${path.basename(modulePath)} must export an async init() function or be itself an async initializer.`
    );
  }

  let candidate;
  try {
    candidate = await initializer.call(initializerContext);
  } catch (error) {
    const enriched = new Error(
      `Module ${path.basename(modulePath)} failed during async init: ${error.message}`
    );
    enriched.cause = error;
    throw enriched;
  }

  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`Module ${path.basename(modulePath)} must resolve to an object descriptor from init().`);
  }

  const app = candidate.app || candidate.expressApp || candidate.handler;
  if (typeof app !== 'function') {
    throw new Error(
      `Module ${path.basename(modulePath)} must provide an Express app via init() -> app/expressApp/handler.`
    );
  }

  const exportedDomains =
    candidate.domains ||
    candidate.domain ||
    candidate.hosts ||
    candidate.host ||
    (rawExport && typeof rawExport === 'object'
      ? rawExport.domains || rawExport.domain || rawExport.hosts || rawExport.host
      : undefined);
  const domains = Array.isArray(exportedDomains)
    ? exportedDomains
    : exportedDomains
    ? [exportedDomains]
    : [];
  if (!domains.length) {
    throw new Error(`Module ${path.basename(modulePath)} must declare at least one domain.`);
  }

  const metaSources = [];
  if (rawExport && typeof rawExport === 'object' && rawExport.meta && typeof rawExport.meta === 'object') {
    metaSources.push(rawExport.meta);
  }
  if (candidate.meta && typeof candidate.meta === 'object') {
    metaSources.push(candidate.meta);
  }
  const meta = metaSources.reduce((acc, fragment) => Object.assign(acc, fragment), {});

  return { app, domains, meta };
}

function parseStaticAndProxiesDomains(filePath, filename, filetype) {
  const sanitizeDomain = (value) => {
    let domain = value.trim();
    domain = domain.replace(/^https?:\/\//i, '');
    domain = domain.replace(/\/+$/, '');
    return domain;
  };

  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    const rawLines = contents.split(/\r?\n/);

    const domains = [];
    const rewrittenLines = [];
    let changed = false;

    rawLines.forEach((line) => {
      const trimmed = line.trim();
      if (trimmed !== line) {
        changed = true;
      }
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        rewrittenLines.push(line);
        return;
      }

      const sanitized = sanitizeDomain(trimmed);
      if (sanitized !== trimmed) {
        changed = true;
      }

      rewrittenLines.push(sanitized);

      if (sanitized) {
        domains.push(sanitized);
      }
    });

    const updatedContent = rewrittenLines.join('\n');

    if (changed && updatedContent !== contents) {
      try {
        fs.writeFileSync(filePath, updatedContent, 'utf8');
        console.log(`Normalized ${filetype} definition ${filename}`);
      } catch (writeError) {
        console.warn(
          `Could not rewrite ${filetype} definition ${filename} without protocol prefixes: ${writeError.message}`
        );
      }
    }

    if (domains.length) {
      return domains;
    }
  } catch (error) {
    console.warn(`Could not read ${filetype} definition ${filename}: ${error.message}`);
  }

  // Fallback: infer from filename by stripping known extensions
  const base = filename.replace(/\.hts\.txt$/i, '').replace(/\.txt$/i, '');
  return base ? [base] : [];
}

function loadStaticDescriptors() {
  const discovered = discoverStaticFiles();

  return discovered.map(({ absolutePath, displayName }) => {
    const domains = parseStaticAndProxiesDomains(absolutePath, displayName, 'static');
    return {
      type: 'static',
      filename: displayName,
      absolutePath,
      domains,
    };
  });
}

function loadProxyDescriptors() {
  const discovered = discoverProxyFiles();
  return discovered.map(({ absolutePath, displayName }) => {
    let domains = [];
    let target;

    try {
      const contents = fs.readFileSync(absolutePath, 'utf8');
      const lines = contents.split(/\r?\n/);

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
          continue;
        }

        const [rawDomain, rawTarget] = trimmed.split(/\s+/, 2);
        if (!rawDomain || !rawTarget) {
          continue;
        }

        const sanitizeDomain = (value) => {
          let domain = value.trim();
          domain = domain.replace(/^https?:\/\//i, '');
          domain = domain.replace(/\/+$/, '');
          return domain;
        };

        const sanitizedDomain = sanitizeDomain(rawDomain);
        if (sanitizedDomain) {
          domains.push(sanitizedDomain);
        }

        let normalizedTarget = rawTarget;
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalizedTarget)) {
          if (/^[^:]+:[0-9]+$/.test(normalizedTarget)) {
            normalizedTarget = `http://${normalizedTarget}`;
          } else if (/^[0-9]+$/.test(normalizedTarget)) {
            normalizedTarget = `http://localhost:${normalizedTarget}`;
          } else {
            normalizedTarget = `http://${normalizedTarget}`;
          }
        }

        target = normalizedTarget;
        break;
      }
    } catch (error) {
      console.warn(`Could not read proxy definition ${displayName}: ${error.message}`);
    }

    if (!domains.length || !target) {
      const baseName = displayName.replace(/\.proxy\.hts$/i, '');
      const parts = baseName.split('.');
      let portPart;
      if (parts.length > 1 && /^[0-9]+$/.test(parts[parts.length - 1])) {
        portPart = parts.pop();
      }
      const fallbackDomain = parts.join('.');
      if (!domains.length && fallbackDomain) {
        domains = [fallbackDomain];
      }
      const port = portPart || '80';
      if (!target) {
        target = `http://localhost:${port}`;
      }
    }

    return {
      type: 'proxy',
      filename: displayName,
      absolutePath,
      domains,
      target
    };
  });
}

function shouldCompressStatic(req, res) {
  const noCompression = req.headers['x-no-compression'];
  if (noCompression) {
    return false;
  }
  const ext = path.extname(req.path || '').toLowerCase();
  const alreadyCompressed = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico', '.svg', '.svgz',
    '.zip', '.gz', '.bz2', '.rar', '.7z',
    '.mp4', '.webm', '.mov', '.avi', '.mp3', '.ogg', '.wav', '.aac', '.flac',
    '.pdf'
  ]);
  return !alreadyCompressed.has(ext);
}

function createStaticApp(rootDir) {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Static root ${rootDir} does not exist or is not a directory`);
  }
  const app = express();
  app.use(compression({ threshold: 0, filter: shouldCompressStatic }));
  // Serve index.html for directory requests if present.
  app.use((req, res, next) => {
    const cleaned = req.path.replace(/\/+$/, '') || '/';
    const candidates = ['index.html', 'index.htm', 'default.html', 'default.htm'];
    for (const file of candidates) {
      const target =
        cleaned === '/'
          ? path.join(rootDir, file)
          : path.join(rootDir, cleaned, file);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        res.sendFile(target);
        return;
      }
    }
    next();
  });
  app.use(
    serveStatic(rootDir, {
      fallthrough: true,
      extensions: ['html', 'htm'],
    })
  );
  app.use((req, res) => {
    res.status(404).send('Not found');
  });
  return app;
}

function createStaticAppDescriptors(descriptors) {
  const results = [];
  descriptors.forEach(({ filename, absolutePath, domains }) => {
    const rootDir = path.dirname(absolutePath);
    try {
      const app = createStaticApp(rootDir);
      results.push({ filename, domains, app });
    } catch (error) {
      console.warn(`Skipping static ${filename}: ${error.message}`);
    }
  });
  return results;
}

function createProxyApp(target) {
  const app = express();
  app.use(
    createProxyMiddleware({
      target,
      changeOrigin: false,
    })
  );
  return app;
}

function createProxyAppDescriptors(descriptors) {
  const results = [];
  descriptors.forEach(({ filename, domains, target }) => {
    try {
      const app = createProxyApp(target);
      results.push({ filename, domains, app });
    } catch (error) {
      console.warn(`Skipping proxy ${filename}: ${error.message}`);
    }
  });
  return results;
}

async function loadServersFromDisk() {
  const moduleSpecs = discoverServerModules();

  if (!moduleSpecs.length) {
    console.error('No server modules matching hts.js were found in the filesystem.');
  }

  const serverDescriptors = [];
  for (const { absolutePath, displayName } of moduleSpecs) {
    const descriptor = await loadServerDescriptor(absolutePath);
    serverDescriptors.push({ ...descriptor, filename: displayName, absolutePath });
  }

  return serverDescriptors;
}

function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined;
}

function parseCertificateDomains(certBuffer, fallbackDomain) {
  if (!certBuffer) {
    return fallbackDomain ? [fallbackDomain] : [];
  }

  try {
    const certificate = new X509Certificate(certBuffer);
    const altNames = certificate.subjectAltName
      ? certificate.subjectAltName
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.startsWith('DNS:'))
          .map((entry) => entry.slice(4).toLowerCase())
      : [];

    if (altNames.length) {
      return altNames;
    }
  } catch (error) {
    console.warn(`Could not parse certificate SANs for ${fallbackDomain}: ${error.message}`);
  }

  return fallbackDomain ? [fallbackDomain.toLowerCase()] : [];
}

function loadCertificateEntries() {
  if (!fs.existsSync(CERT_ROOT)) {
    throw new Error(`Certificate directory ${CERT_ROOT} does not exist.`);
  }

  const directories = fs.readdirSync(CERT_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (!directories.length) {
    throw new Error(`No certificates found under ${CERT_ROOT}.`);
  }

  const entries = directories.map((entry) => {
    const certDir = path.join(CERT_ROOT, entry.name);
    const keyPath = path.join(certDir, 'privkey.pem');
    const certPath = path.join(certDir, 'cert.pem');
    const chainPath = path.join(certDir, 'chain.pem');

    const key = readFileIfExists(keyPath);
    const cert = readFileIfExists(certPath);
    const ca = readFileIfExists(chainPath);

    if (!key || !cert) {
      throw new Error(`Missing key or certificate in ${certDir}.`);
    }

    const domains = parseCertificateDomains(cert, entry.name);
    return { key, cert, ca, domains, source: certDir };
  });

  return entries;
}

function domainMatchesPattern(domain, pattern) {
  const d = String(domain || '').toLowerCase();
  const p = String(pattern || '').toLowerCase();

  if (!d || !p) {
    return false;
  }

  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // keep the leading dot for clarity
    return d.endsWith(suffix) && d.length > suffix.length;
  }

  return d === p;
}

function hasCertificateForDomain(domain, certEntries) {
  return certEntries.some(({ domains }) => domains.some((pattern) => domainMatchesPattern(domain, pattern)));
}

function writeConfigFile(serverDescriptors, staticDescriptors, proxiesDescriptors, certEntries) {
  const lines = [];

  serverDescriptors.forEach(({ filename, absolutePath, domains }) => {
    const id = absolutePath || path.join(__dirname, filename);
    lines.push(id);
    lines.push('  type: express');
    lines.push(`  dir: ${path.dirname(id)}`);
    lines.push('  domains:');
    domains.forEach((domain) => {
      const certStatus = hasCertificateForDomain(domain, certEntries) ? 'present' : 'missing';
      lines.push(`    - ${domain} (cert: ${certStatus})`);
    });
    lines.push('');
  });

  staticDescriptors.forEach(({ filename, absolutePath, domains }) => {
    const id = absolutePath || path.join(__dirname, filename);
    lines.push(id);
    lines.push('  type: static');
    lines.push(`  dir: ${path.dirname(id)}`);
    lines.push('  domains:');
    if (!domains.length) {
      lines.push('    - (none) (cert: n/a)');
    } else {
      domains.forEach((domain) => {
        const certStatus = hasCertificateForDomain(domain, certEntries) ? 'present' : 'missing';
        lines.push(`    - ${domain} (cert: ${certStatus})`);
      });
    }
    lines.push('');
  });

  proxiesDescriptors.forEach(({ filename, absolutePath, domains,target }) => {
    const id = absolutePath || path.join(__dirname, filename);
    lines.push(id);
    lines.push('  type: static');
    lines.push(`  target: ${target}`);
    lines.push('  domains:');
    if (!domains.length) {
      lines.push('    - (none) (cert: n/a)');
    } else {
      domains.forEach((domain) => {
        const certStatus = hasCertificateForDomain(domain, certEntries) ? 'present' : 'missing';
        lines.push(`    - ${domain} (cert: ${certStatus})`);
      });
    }
    lines.push('');
  });

  fs.writeFileSync(CONFIG_PATH, lines.join('\n'));
  console.log(`Wrote config summary to ${CONFIG_PATH}`);
}

function parseConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { servers: [], statics: [], proxies: [] };
  }

  const content = fs.readFileSync(CONFIG_PATH, 'utf8');
  const lines = content.split(/\r?\n/);
  const entries = [];
  let current = null;

  const flush = () => {
    if (current && current.type && current.id) {
      current.domains = current.domains || [];
      entries.push(current);
    }
    current = null;
  };

  lines.forEach((line) => {
    if (!line.trim()) {
      flush();
      return;
    }

    if (!line.startsWith(' ')) {
      flush();
      current = { id: line.trim(), domains: [] };
      return;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('type:')) {
      current.type = trimmed.split(':').slice(1).join(':').trim();
      return;
    }
    if (trimmed.startsWith('target:')) {
      current.target = trimmed.split(':').slice(1).join(':').trim();
      return;
    }
    if (trimmed.startsWith('dir:')) {
      current.dir = trimmed.split(':').slice(1).join(':').trim();
      return;
    }
    if (trimmed.startsWith('-')) {
      const domainPart = trimmed.slice(1).trim();
      const withoutCert = domainPart.replace(/\(cert:.*\)$/i, '').trim();
      if (withoutCert && withoutCert !== '(none)') {
        current.domains.push(withoutCert);
      }
    }
  });
  flush();

  const servers = entries
    .filter((e) => e.type === 'express' && e.id)
    .map((e) => {
      const absolutePath = path.isAbsolute(e.id)
        ? e.id
        : e.dir
        ? path.join(e.dir, e.id)
        : path.join(__dirname, e.id);
      return {
        absolutePath,
        displayName: path.basename(absolutePath),
        domains: e.domains || [],
      };
    });

  const statics = entries
    .filter((e) => e.type === 'static' && e.id)
    .map((e) => {
      const absolutePath = path.isAbsolute(e.id)
        ? e.id
        : e.dir
        ? path.join(e.dir, e.id)
        : path.join(__dirname, e.id);
      return {
        absolutePath,
        displayName: path.basename(absolutePath),
        domains: e.domains || [],
      };
    });

  const proxies = entries
    .filter((e) => e.type === 'proxy' && e.id)
    .map((e) => {
      const absolutePath = path.isAbsolute(e.id)
        ? e.id
        : e.dir
        ? path.join(e.dir, e.id)
        : path.join(__dirname, e.id);
      return {
        absolutePath,
        displayName: path.basename(absolutePath),
        domains: e.domains || [],
      };
    });

  return { servers, statics, proxies };
}

async function reconcileConfigInteractive() {
  const existing = parseConfigFile();
  const existingServerMap = new Map(
    existing.servers.map((s) => [path.normalize(s.absolutePath), s])
  );
  const existingStaticMap = new Map(
    existing.statics.map((s) => [path.normalize(s.absolutePath), s])
  );
  const existingProxiesMap = new Map(
    existing.proxies.map((s) => [path.normalize(s.absolutePath), s])
  );

  const finalProxies = [];
  const finalServers = [];
  const finalStatics = [];
  const seenProxies = new Set();
  const seenServers = new Set();
  const seenStatics = new Set();

  const scannedServers = discoverServerModules();
  for (const spec of scannedServers) {
    const abs = path.normalize(spec.absolutePath);
    let descriptor;
    try {
      descriptor = await loadServerDescriptor(abs);
    } catch (error) {
      console.warn(`Skipping ${abs}: ${error.message}`);
      continue;
    }

    seenServers.add(abs);
    const existingEntry = existingServerMap.get(abs);
    let domains = descriptor.domains;

    if (existingEntry) {
      const stored = existingEntry.domains || [];
      const additions = domains.filter((d) => !stored.includes(d));
      const removals = stored.filter((d) => !domains.includes(d));
      if (additions.length || removals.length) {
        const answer = await askYesNo(
          `Update domains for ${abs}? existing: [${stored.join(', ')}], current: [${domains.join(', ')}]`,
          true
        );
        if (!answer) {
          domains = stored;
        }
      }
    } else {
      const answer = await askYesNo(
        `Add new Express module ${abs} with domains [${domains.join(', ')}]?`,
        true
      );
      if (!answer) {
        continue;
      }
    }

    finalServers.push({ ...descriptor, filename: spec.displayName, absolutePath: abs, domains });
  }

  for (const [abs, entry] of existingServerMap.entries()) {
    if (seenServers.has(abs)) {
      continue;
    }
    const keep = await askYesNo(
      `Config references ${abs} but it was not found in scan. Keep it?`,
      false
    );
    if (!keep) {
      continue;
    }
    try {
      const descriptor = await loadServerDescriptor(abs);
      const domains = (entry.domains && entry.domains.length) ? entry.domains : descriptor.domains;
      finalServers.push({
        ...descriptor,
        filename: entry.displayName || path.basename(abs),
        absolutePath: abs,
        domains,
      });
    } catch (error) {
      console.warn(`Skipping ${abs}: ${error.message}`);
    }
  }

  const scannedStatics = loadStaticDescriptors();
  for (const { filename, absolutePath, domains } of scannedStatics) {
    const abs = path.normalize(absolutePath);
    seenStatics.add(abs);
    const existingEntry = existingStaticMap.get(abs);
    let effectiveDomains = domains;

    if (existingEntry) {
      const stored = existingEntry.domains || [];
      const additions = effectiveDomains.filter((d) => !stored.includes(d));
      const removals = stored.filter((d) => !effectiveDomains.includes(d));
      if (additions.length || removals.length) {
        const answer = await askYesNo(
          `Update domains for static ${abs}? existing: [${stored.join(', ')}], current: [${effectiveDomains.join(', ')}]`,
          true
        );
        if (!answer) {
          effectiveDomains = stored;
        }
      }
    } else {
      const answer = await askYesNo(
        `Add new static definition ${abs} with domains [${effectiveDomains.join(', ')}]?`,
        true
      );
      if (!answer) {
        continue;
      }
    }

    finalStatics.push({
      type: 'static',
      filename,
      absolutePath: abs,
      domains: effectiveDomains,
    });
  }

  for (const [abs, entry] of existingStaticMap.entries()) {
    if (seenStatics.has(abs)) {
      continue;
    }
    const keep = await askYesNo(
      `Config references static ${abs} but it was not found in scan. Keep it?`,
      false
    );
    if (!keep) {
      continue;
    }
    let domains = entry.domains || [];
    if (fs.existsSync(abs)) {
      domains = parseStaticAndProxiesDomains(abs, path.basename(abs),'static');
    }
    finalStatics.push({
      type: 'static',
      filename: entry.displayName || path.basename(abs),
      absolutePath: abs,
      domains,
    });
  }


  const scannedProxies = loadProxyDescriptors();
  for (const { filename, absolutePath, domains } of scannedProxies) {
    const abs = path.normalize(absolutePath);
    seenProxies.add(abs);
    const existingEntry = existingProxiesMap.get(abs);
    let effectiveDomains = domains;

    if (existingEntry) {
      const stored = existingEntry.domains || [];
      const additions = effectiveDomains.filter((d) => !stored.includes(d));
      const removals = stored.filter((d) => !effectiveDomains.includes(d));
      if (additions.length || removals.length) {
        const answer = await askYesNo(
          `Update domains for proxy ${abs}? existing: [${stored.join(', ')}], current: [${effectiveDomains.join(', ')}]`,
          true
        );
        if (!answer) {
          effectiveDomains = stored;
        }
      }
    } else {
      const answer = await askYesNo(
        `Add new proxy definition ${abs} with domains [${effectiveDomains.join(', ')}]?`,
        true
      );
      if (!answer) {
        continue;
      }
    }

    finalProxies.push({
      type: 'proxy',
      filename,
      absolutePath: abs,
      domains: effectiveDomains,
    });
  }

  for (const [abs, entry] of existingProxiesMap.entries()) {
    if (seenProxies.has(abs)) {
      continue;
    }
    const keep = await askYesNo(
      `Config references proxy ${abs} but it was not found in scan. Keep it?`,
      false
    );
    if (!keep) {
      continue;
    }
    let domains = entry.domains || [];
    if (fs.existsSync(abs)) {
      domains = parseStaticAndProxiesDomains(abs, path.basename(abs),'proxy');
    }
    finalProxies.push({
      type: 'proxy',
      filename: entry.displayName || path.basename(abs),
      absolutePath: abs,
      domains,
    });
  }

  return { serverDescriptors: finalServers, staticDescriptors: finalStatics, proxiesDescriptors: finalProxies };
}

function buildDomainAppMap(serverDescriptors, staticAppDescriptors, proxyAppDescriptors = []) {
  const domainToApp = new Map();

  const attachDescriptors = (descriptors) => {
    descriptors.forEach(({ domains, app, filename }) => {
      domains.forEach((domain) => {
        const normalized = String(domain).trim().toLowerCase();
        if (!normalized) {
          return;
        }
        if (domainToApp.has(normalized)) {
          console.warn(`Domain ${normalized} already mapped; overriding with app from ${filename}.`);
        }
        domainToApp.set(normalized, { app, source: filename });
      });
    });
  };

  attachDescriptors(serverDescriptors);
  attachDescriptors(staticAppDescriptors);
  attachDescriptors(proxyAppDescriptors);

  return domainToApp;
}

function attachCertificateContexts(server, certEntries) {
  const assigned = new Set();

  certEntries.forEach(({ key, cert, ca, domains, source }) => {
    domains.forEach((domain) => {
      const normalized = domain.trim().toLowerCase();
      if (!normalized || assigned.has(normalized)) {
        return;
      }
      const context = tls.createSecureContext({ key, cert, ca });
      server.addContext(normalized, context);
      assigned.add(normalized);
    });

    if (!domains.length) {
      console.warn(`No domains determined for certificate in ${source}; skipping addContext.`);
    }
  });
}

function buildCertDomainSet(certEntries) {
  const set = new Set();
  certEntries.forEach(({ domains }) => {
    (domains || []).forEach((d) => {
      const normalized = String(d || '').trim().toLowerCase();
      if (normalized) {
        set.add(normalized);
      }
    });
  });
  return set;
}

function createRequestHandler(domainToApp, certDomainSet = new Set()) {
  return function httpsRequestHandler(req, res) {
    const hostHeader = req.headers.host || '';
    const hostname = hostHeader.split(':')[0].toLowerCase();
    const mapping = domainToApp.get(hostname);

    if (certDomainSet.has(hostname)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
      res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests');
    }

    if (!mapping) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('No application configured for this domain.');
      return;
    }

    try {
      mapping.app(req, res);
    } catch (error) {
      console.error(`Error handling request for ${hostname} via ${mapping.source}:`, error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end('Internal server error.');
    }
  };
}

async function main(options = {}) {
  printHelp();
  applyConfiguration(options);

  if (options.help) {
    return;
  }

  const shouldUpdate = options.update || !fs.existsSync(CONFIG_PATH);

  let serverDescriptors = [];
  let staticDescriptors = [];
  let proxyDescriptors = [];
  let certificateEntries = [];

  if (shouldUpdate) {
    const reconciled = await reconcileConfigInteractive();
    serverDescriptors = reconciled.serverDescriptors;
    staticDescriptors = reconciled.staticDescriptors;
    proxyDescriptors = reconciled.proxyDescriptors || [];
    certificateEntries = loadCertificateEntries();
    writeConfigFile(serverDescriptors, staticDescriptors, proxyDescriptors, certificateEntries);
    if (options.update) {
      console.log('Interactive update complete. Exiting (--update).');
      return;
    }
  } else {
    const parsed = parseConfigFile();
    const { servers, statics } = parsed;
    staticDescriptors = statics.map((entry) => ({
      type: 'static',
      filename: entry.displayName,
      absolutePath: entry.absolutePath,
      domains: entry.domains || [],
    }));

    serverDescriptors = [];
    for (const spec of servers) {
      try {
        const descriptor = await loadServerDescriptor(spec.absolutePath);
        const domains =
          spec.domains && spec.domains.length ? spec.domains : descriptor.domains;
        serverDescriptors.push({ ...descriptor, filename: spec.displayName, absolutePath: spec.absolutePath, domains });
      } catch (error) {
        console.warn(`Skipping ${spec.displayName}: ${error.message}`);
      }
    }
    certificateEntries = loadCertificateEntries();
  }

  // Proxies are discovered from disk for runtime routing; config is summary-only.
  proxyDescriptors = loadProxyDescriptors();
  const proxyApps = createProxyAppDescriptors(proxyDescriptors);
  const staticApps = createStaticAppDescriptors(staticDescriptors);
  const domainToApp = buildDomainAppMap(serverDescriptors, staticApps, proxyApps);
  const certDomainSet = buildCertDomainSet(certificateEntries);

  const primaryCert = certificateEntries[0];
  const httpsServer = https.createServer(
    {
      key: primaryCert.key,
      cert: primaryCert.cert,
      ca: primaryCert.ca,
    },
    createRequestHandler(domainToApp, certDomainSet)
  );

  attachCertificateContexts(httpsServer, certificateEntries);

  httpsServer.on('listening', () => {
    console.log(`HTTPS server listening on port ${HTTPS_PORT}.`);
  });

  httpsServer.on('error', (error) => {
    console.error('HTTPS server encountered an error:', error);
  });

  httpsServer.listen(HTTPS_PORT);
}

if (require.main === module) {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  if (cliOptions.help) {
    printHelp();
    process.exit(0);
  }

  if (cliOptions.writeTemplate) {
    try {
      writeTemplateFile(cliOptions.writeTemplate);
      process.exit(0);
    } catch (error) {
      process.exit(1);
    }
  }

  main(cliOptions).catch((error) => {
    console.error(error.message || error);
    if (error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  });
}

module.exports = { main };
