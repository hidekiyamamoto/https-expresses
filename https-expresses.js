'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const Module = require('module');
const { execSync } = require('child_process');
const { X509Certificate } = require('crypto');

// Default configuration
const DEFAULT_CONFIG = {
  serversPattern: '.*\\.hts.js$',
  staticPattern: '.*\\.hts.txt$',
  staticDirs: [],
  manualModules: [],
  certRoot: '/etc/letsencrypt/live',
  httpsPort: 443,
};

let SERVERS_PATTERN = new RegExp(DEFAULT_CONFIG.serversPattern);
let STATIC_PATTERN = new RegExp(DEFAULT_CONFIG.staticPattern);
let STATIC_DIRS = [...DEFAULT_CONFIG.staticDirs];
let MANUAL_SERVER_MODULES = [...DEFAULT_CONFIG.manualModules];
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

function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {};
  const manualModules = [];
  const staticDirs = [];

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
      case '--manual-module':
      case '--manual':
        manualModules.push(argv[i + 1]);
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
      case '--static-dir':
        staticDirs.push(argv[i + 1]);
        i += 1;
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

  if (manualModules.length) {
    options.manualModules = manualModules.filter(Boolean);
  }
  if (staticDirs.length) {
    options.staticDirs = staticDirs.filter(Boolean);
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

  if (Array.isArray(overrides.staticDirs)) {
    const combinedDirs = [...DEFAULT_CONFIG.staticDirs, ...overrides.staticDirs].filter(Boolean);
    const seenDirs = new Set();
    STATIC_DIRS = combinedDirs
      .map((dir) => (path.isAbsolute(dir) ? dir : path.join(__dirname, dir)))
      .map((dir) => path.normalize(dir))
      .filter((dir) => {
        if (seenDirs.has(dir)) {
          return false;
        }
        seenDirs.add(dir);
        return true;
      });
  }

  if (Array.isArray(overrides.manualModules)) {
    const combinedManual = [...DEFAULT_CONFIG.manualModules, ...overrides.manualModules].filter(Boolean);
    // Normalize and deduplicate manual module paths
    const seen = new Set();
    MANUAL_SERVER_MODULES = combinedManual.filter((entry) => {
      const normalized = path.normalize(entry);
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });
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
  -h, --help                Show this help message
  --https-port <port>       HTTPS port to listen on (default: ${DEFAULT_CONFIG.httpsPort})
  --cert-root <path>        Directory containing certificate folders (default: ${DEFAULT_CONFIG.certRoot})
  --pattern <regex>         Regex for auto-loading server modules (default: ${DEFAULT_CONFIG.serversPattern})
  --static-pattern <regex>  Regex for auto-loading static definitions (default: ${DEFAULT_CONFIG.staticPattern})
  --static-dir <path>       Extra directory to scan for static definitions; repeatable (default: ${DEFAULT_CONFIG.staticDirs.join(', ') || 'none'})
  --manual-module <path>    Extra module path(s) to load; repeatable (default: ${DEFAULT_CONFIG.manualModules.join(', ')})
  --write-template [path]   Write a starter template file (default path: template.hts.js) and exit

What it does:
  - Discovers Express apps from files matching the pattern and manual module list.
  - Discovers static site definitions from files matching --static-pattern.
  - Auto-loads certificates from --cert-root and configures SNI.
  - Routes HTTPS traffic by Host header to the matching Express app.

Prerequisites:
  - Node.js runtime and npm available in PATH.
  - Certificates laid out like LetsEncrypt under --cert-root (privkey.pem, cert.pem, chain.pem).
  - Network access to install missing dependencies on first run (auto-installs when possible).
`;

  console.log(usage.trim());
}

function discoverServerModules() {
  const directoryEntries = fs.readdirSync(__dirname, { withFileTypes: true });
  return directoryEntries
    .filter((entry) => entry.isFile() && SERVERS_PATTERN.test(entry.name))
    .map((entry) => entry.name);
}

function discoverStaticFiles() {
  const matches = new Set();
  const skipDirs = new Set(['node_modules', '.git', '.hg', '.svn']);

  const roots = STATIC_DIRS.length ? STATIC_DIRS : ['/'];

  roots.forEach((root) => {
    const rootPath = path.normalize(root);
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      console.warn(`Static dir ${rootPath} does not exist or is not a directory; skipping.`);
      return;
    }

    const stack = [rootPath];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (error) {
        console.warn(`Could not read directory ${current}: ${error.message}`);
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
        if (entry.isFile() && STATIC_PATTERN.test(entry.name)) {
          matches.add(path.normalize(fullPath));
        }
      });
    }
  });

  return Array.from(matches).map((absolutePath) => ({
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

function parseStaticDomains(filePath, filename) {
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
        console.log(`Normalized static definition ${filename}`);
      } catch (writeError) {
        console.warn(
          `Could not rewrite static definition ${filename} without protocol prefixes: ${writeError.message}`
        );
      }
    }

    if (domains.length) {
      return domains;
    }
  } catch (error) {
    console.warn(`Could not read static definition ${filename}: ${error.message}`);
  }

  // Fallback: infer from filename by stripping known extensions
  const base = filename.replace(/\.hts\.txt$/i, '').replace(/\.txt$/i, '');
  return base ? [base] : [];
}

function loadStaticDescriptors() {
  const discovered = discoverStaticFiles();

  return discovered.map(({ absolutePath, displayName }) => {
    const domains = parseStaticDomains(absolutePath, displayName);
    return {
      type: 'static',
      filename: displayName,
      absolutePath,
      domains,
    };
  });
}

function createStaticApp(rootDir) {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Static root ${rootDir} does not exist or is not a directory`);
  }
  const app = express();
  app.use(compression());
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

function createStaticAppDescriptors(staticDescriptors) {
  const results = [];
  staticDescriptors.forEach(({ filename, absolutePath, domains }) => {
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

async function loadServersFromDisk() {
  const discovered = discoverServerModules().map((filename) => ({
    absolutePath: path.join(__dirname, filename),
    displayName: filename,
  }));

  const manual = MANUAL_SERVER_MODULES.map((modulePath) => {
    const absolutePath = path.isAbsolute(modulePath)
      ? modulePath
      : path.join(__dirname, modulePath);
    const displayName = path.relative(__dirname, absolutePath) || path.basename(absolutePath);
    return { absolutePath, displayName };
  });

  const moduleSpecs = [];
  const seen = new Set();

  [...manual, ...discovered].forEach((spec) => {
    const normalized = path.normalize(spec.absolutePath);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    moduleSpecs.push({ ...spec, absolutePath: normalized });
  });

  if (!moduleSpecs.length) {
    console.error('No server modules matching hts.js were found in this directory.');
    //throw new Error('No server modules matching hts.js were found in this directory.');
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

function writeConfigFile(serverDescriptors, staticDescriptors, certEntries) {
  const configPath = path.join(__dirname, 'https-expresses.cfg');
  const lines = [];

  serverDescriptors.forEach(({ filename, absolutePath, domains }) => {
    lines.push(filename);
    lines.push('  type: express');
    lines.push(`  dir: ${path.dirname(absolutePath || path.join(__dirname, filename))}`);
    lines.push('  domains:');
    domains.forEach((domain) => {
      const certStatus = hasCertificateForDomain(domain, certEntries) ? 'present' : 'missing';
      lines.push(`    - ${domain} (cert: ${certStatus})`);
    });
    lines.push('');
  });

  staticDescriptors.forEach(({ filename, absolutePath, domains }) => {
    lines.push(filename);
    lines.push('  type: static');
    lines.push(`  dir: ${path.dirname(absolutePath || path.join(__dirname, filename))}`);
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

  fs.writeFileSync(configPath, lines.join('\n'));
  console.log(`Wrote config summary to ${configPath}`);
}

function buildDomainAppMap(serverDescriptors, staticAppDescriptors = []) {
  const domainToApp = new Map();

  serverDescriptors.forEach(({ domains, app, filename }) => {
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

  staticAppDescriptors.forEach(({ domains, app, filename }) => {
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

function createRequestHandler(domainToApp) {
  return function httpsRequestHandler(req, res) {
    const hostHeader = req.headers.host || '';
    const hostname = hostHeader.split(':')[0].toLowerCase();
    const mapping = domainToApp.get(hostname);

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
  applyConfiguration(options);

  const serverDescriptors = await loadServersFromDisk();
  const staticDescriptors = loadStaticDescriptors();
  const staticApps = createStaticAppDescriptors(staticDescriptors);
  const domainToApp = buildDomainAppMap(serverDescriptors, staticApps);
  const certificateEntries = loadCertificateEntries();
  writeConfigFile(serverDescriptors, staticDescriptors, certificateEntries);

  const primaryCert = certificateEntries[0];
  const httpsServer = https.createServer(
    {
      key: primaryCert.key,
      cert: primaryCert.cert,
      ca: primaryCert.ca,
    },
    createRequestHandler(domainToApp)
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
  applyConfiguration(cliOptions);

  if (cliOptions.writeTemplate) {
    try {
      writeTemplateFile(cliOptions.writeTemplate);
      process.exit(0);
    } catch (error) {
      process.exit(1);
    }
  }

  main().catch((error) => {
    console.error(error.message || error);
    if (error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  });
}

module.exports = { main };
