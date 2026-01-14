'use strict';
const fs=require('fs');const path=require('path');
const https=require('https');const tls=require('tls');
const Module=require('module');const readline=require('readline');
const { execSync }=require('child_process');
const { X509Certificate }=require('crypto');

// Ensure locally installed dependencies are visible when loading modules outside this directory.
const LOCAL_NODE_MODULES=path.join(__dirname, 'node_modules');
process.env.NODE_PATH=[LOCAL_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

// Default configuration
const DEFAULT_CONFIG={
  proxyPattern: '.*\\.proxy.hts$',
  staticPattern: '.*\\.static.hts$',
  serversPattern: '.*\\.hts.js$',
  certRoot: '/etc/letsencrypt/live',
  httpsPort: 443,
};

const CONFIG_PATH=path.join(__dirname, 'https-expresses.cfg');

let PROXY_PATTERN=new RegExp(DEFAULT_CONFIG.proxyPattern);
let STATIC_PATTERN=new RegExp(DEFAULT_CONFIG.staticPattern);
let SERVERS_PATTERN=new RegExp(DEFAULT_CONFIG.serversPattern);
let CERT_ROOT=DEFAULT_CONFIG.certRoot;
let HTTPS_PORT=DEFAULT_CONFIG.httpsPort; // Number(process.env.HTTPS_PORT || 443);
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # */
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # HELPERS - START */
function readFileIfExists(filePath) {return fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined;}
function hasWriteAccess(targetPath) {try {fs.accessSync(targetPath, fs.constants.W_OK);return true;} catch {return false;}}
function sanitizeDomain(value){let domain=String(value||'').trim();domain=domain.replace(/^https?:\/\//i,'');domain=domain.replace(/\/+$/,'');return domain;}
/* HELPERS - END # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # */
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # PREREQUISITES AUTOINSTALL - START */
function attemptInstall(moduleName) {
  if (!hasWriteAccess(process.cwd())) {
    throw new Error(`Cannot install missing dependency "${moduleName}" because there is no write access to ${process.cwd()}.`);
  }
  try {execSync('npm --version', { stdio: 'ignore' });}
  catch (error) {throw new Error(`Cannot install missing dependency "${moduleName}" because npm is not available.`);}
  console.log(`Auto-installing missing dependency "${moduleName}"...`);
  execSync(`npm install ${moduleName}`, { stdio:'inherit'});
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
const originalRequire=Module.prototype.require;
Module.prototype.require=function patchedRequire(request) {
  try{return originalRequire.apply(this, arguments);}
  catch(error){
    if(shouldAutoInstall(error,request)){
      attemptInstall(request);return originalRequire.apply(this,arguments);}
    throw error;
} };
function loadExternalModule(name) {
  try {return require(name);} catch (error) {
    // The patched require should already try auto-install; this is a final fallback.
    if (shouldAutoInstall(error,name)){attemptInstall(name);return require(name);}
    throw error;
}}
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # */
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # */
const httpExpresses={
  APP_TEMPLATE:`'use strict';
// Domains this service will answer for. Update these to your real hostnames.
const DOMAINS=['example.com', 'www.example.com'];
// Optional metadata shown in https-expresses summaries.
const MODULE_META={
  description: 'Starter Express app for https-expresses.',
  // Optional async initialization hook called by https-expresses
  // before the HTTPS server starts listening.
  // initModule: async ({ app, domains, meta }) => {
  //   // Place module-level startup logic here (e.g. DB connections).
  // },
};
const fs=require('fs');
const path=require('path');
const express=require('express');
const compression=require('compression');
module.exports={
  domains:DOMAINS,meta:MODULE_META,
  async init() {
    const app=express();
    // Core middleware
    app.use(compression());
    app.use(express.json({limit:'5mb'}));
    app.use(express.urlencoded({extended:false}));
    // Static files (optional)
    const publicDir=path.join(__dirname, 'www-public');
    if (fs.existsSync(publicDir) && fs.statSync(publicDir).isDirectory()) {
      app.use(express.static(publicDir));
      console.log('[TEMPLATE] Serving static files from', publicDir);
    }
    // Simple endpoint
    app.get('/example_endpoint',(req,res)=>{
      res.send(JSON.stringify({"response":"hallo https-expresses"}));
    });
    return {app,domains:DOMAINS,meta:MODULE_META};
  }
};`,
HELP_TEXT:`
################################################################
Description:
  https-expresses is a simple and small nodejs program to stop dealing with https certificates, especially
  multiple https certificates for different domains, from the same server. It's also made to avoid installing
  apache or nginx, while maintaining everything certbot relatated automatic and easy.
  
  cool features:
  - Features 3 types of ways for serving content behind https for multiple domains:
    -- express apps, static folders, reverse proxies.
  - Automatic installing of prerequisites on first load.
  - Automatically scans the file system and automatically creates the config (*read info).
  - Interactive config update after the first load.

Usage:
  node ${path.basename(__filename)} [options]
Options:
  --update                  Interactive rescan: add/remove modules/statics and update domains, then exit
  --help                    Show this help message
  --https-port <port>       HTTPS port to listen on (default: ${DEFAULT_CONFIG.httpsPort})
  --cert-root <path>        Directory containing certificate folders (default: ${DEFAULT_CONFIG.certRoot})
  --pattern <regex>         Regex for auto-loading server modules (default: ${DEFAULT_CONFIG.serversPattern})
  --static-pattern <regex>  Regex for auto-loading static definitions (default: ${DEFAULT_CONFIG.staticPattern})
  --proxy-pattern <regex>   Regex for auto-loading proxy definitions (default: ${DEFAULT_CONFIG.proxyPattern})
  --write-template [path]   Write a starter template file (default path: template.hts.js) and exit

What it does:
  - Discovers Express apps from files matching the pattern anywhere under / (use --update to refresh config).
  - Discovers static site definitions from files matching --static-pattern anywhere under / (use --update to refresh config).
  - Auto-loads certificates from --cert-root and configures SNI.
  - Routes HTTPS traffic by Host header to the matching Express app, static files or proxies.
################################################################
`
};

const express=loadExternalModule('express');
const serveStatic=loadExternalModule('serve-static');
const compression=loadExternalModule('compression');
const { createProxyMiddleware }=loadExternalModule('http-proxy-middleware');

function writeTemplateFile(destination) {
  const targetPath=path.isAbsolute(destination) ? destination:path.join(process.cwd(),destination);
  try{
    fs.writeFileSync(targetPath, httpExpresses.APP_TEMPLATE, 'utf8');
    console.log(`Template written to ${targetPath}`);
  }catch (error) {
    console.error(`Failed to write template to ${targetPath}: ${error.message}`);
    throw error;
}}

async function askYesNo(question, defaultYes=true){
  const suffix=defaultYes ? '[Y/n]' : '[y/N]';
  const rl=readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve)=>{
    rl.question(`${question} ${suffix} `,(answer)=>{
      rl.close();
      const normalized=String(answer || '').trim().toLowerCase();
      if(!normalized){resolve(defaultYes);return;}
      resolve(normalized === 'y' || normalized === 'yes');
});});}
function parseCliArgs(argv=process.argv.slice(2)) {
  const options={};
  const flags={
    '--help': ()=>(options.help=true),
    '--https-port': i=>(options.httpsPort=Number(argv[++i])),
    '--cert-root': i=>(options.certRoot=argv[++i]),
    '--pattern': i=>(options.serversPattern=argv[++i]),
    '--static-pattern': i=>(options.staticPattern=argv[++i]),
    '--proxy-pattern': i=>(options.proxyPattern=argv[++i]),
    '--update': ()=>(options.update=true),
    '--write-template': i=>{
      const v=argv[i + 1];
      options.writeTemplate=v && !v.startsWith('-') ? argv[++i] : 'template.hts.js';
    }
  };
  for (let i=0; i < argv.length; i++) flags[argv[i]]?.(i);
  return options;
}

function applyConfiguration(overrides={}) {
  if(overrides.serversPattern){SERVERS_PATTERN=new RegExp(overrides.serversPattern);}
  if(overrides.staticPattern){STATIC_PATTERN=new RegExp(overrides.staticPattern);}
  if(overrides.proxyPattern){PROXY_PATTERN=new RegExp(overrides.proxyPattern);}
  if(overrides.certRoot){CERT_ROOT=overrides.certRoot;}
  if(typeof overrides.httpsPort === 'number' && !Number.isNaN(overrides.httpsPort)) {
    HTTPS_PORT=overrides.httpsPort;
  }
}
function walkMatchingFiles({ root='/', pattern }) {
  const skip=new Set(['node_modules', '.git', '.hg', '.svn']);
  const stack=[path.normalize(root)];
  const matches=new Set();
  while (stack.length){
    let entries;const dir=stack.pop();
    try{entries=fs.readdirSync(dir, { withFileTypes: true });}
    catch{continue;}
    for (const e of entries) {
      const p=path.join(dir, e.name);
      if (e.isDirectory() && !skip.has(e.name)) stack.push(p);
      if (e.isFile() && pattern.test(e.name)) matches.add(path.normalize(p));
  } }
  return [...matches];
}

function discoverFiles(PATTERN) {
  return walkMatchingFiles({ root: '/', pattern: PATTERN }).map((absolutePath)=>({
    absolutePath,displayName:path.basename(absolutePath),
  }));
}

async function loadServerDescriptor(modulePath) {
  const rawExport=require(modulePath);
  let initializer;let initializerContext;
  if (typeof rawExport === 'function') {initializer=rawExport;
  } else if (rawExport && typeof rawExport === 'object' && typeof rawExport.init === 'function') {
    initializer=rawExport.init;initializerContext=rawExport;
  } else if (rawExport && typeof rawExport === 'object' && typeof rawExport.initialize === 'function') {
    initializer=rawExport.initialize;initializerContext=rawExport;
  } else {
    throw new Error(
      `Module ${path.basename(modulePath)} must export an async init() function or be itself an async initializer.`
    );
  }

  let candidate;
  try {
    const wantsContext=initializer.length>0;
    const initArg=wantsContext ? {} : undefined;
    candidate=await initializer.call(initializerContext, initArg);
  }
  catch (error) {
    const enriched=new Error(`Module ${path.basename(modulePath)} failed during async init: ${error.message}`);
    enriched.cause=error;
    throw enriched;
  }
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`Module ${path.basename(modulePath)} must resolve to an object descriptor from init().`);
  }
  const app=candidate.app || candidate.expressApp || candidate.handler;
  if (typeof app !== 'function') {
    throw new Error(`Module ${path.basename(modulePath)} must provide an Express app via init() -> app/expressApp/handler.`);
  }

  const exportedDomains =
    candidate.domains ||
    candidate.domain ||
    candidate.hosts ||
    candidate.host ||
    (rawExport && typeof rawExport === 'object'
      ? rawExport.domains || rawExport.domain || rawExport.hosts || rawExport.host
      : undefined);
  const domains=Array.isArray(exportedDomains)
    ? exportedDomains
    : exportedDomains
    ? [exportedDomains]
    : [];
  if (!domains.length) {throw new Error(`Module ${path.basename(modulePath)} must declare at least one domain.`);}

  const metaSources=[];
  if (rawExport && typeof rawExport === 'object' && rawExport.meta && typeof rawExport.meta === 'object') {
    metaSources.push(rawExport.meta);
  }
  if(candidate.meta && typeof candidate.meta==='object') {metaSources.push(candidate.meta);}
  const meta=metaSources.reduce((acc,fragment)=>Object.assign(acc,fragment),{});
  const initModule =
    (meta && typeof meta.initModule === 'function' && meta.initModule) ||
    (meta && typeof meta.initmodule === 'function' && meta.initmodule) ||
    (rawExport && typeof rawExport.initModule === 'function' && rawExport.initModule) ||
    (candidate && typeof candidate.initModule === 'function' && candidate.initModule) ||
    undefined;
  return {app,domains,meta,initModule};
}

async function parseExpressesDomains(filePath,filename,filetype){
     let descriptor;const abs=path.normalize(filePath);
    try{descriptor=await loadServerDescriptor(abs);}
    catch(e){console.warn(`Skipping ${abs}: ${e.message}`);}
    return descriptor.domains;
}
function parseStaticsAndProxiesDomains(filePath,filename,filetype){
  try {
    const contents=fs.readFileSync(filePath, 'utf8');
    const rawLines=contents.split(/\r?\n/);
    const domains=[];const rewrittenLines=[];
    let changed=false;
    rawLines.forEach((line)=>{
      line=line.split(' ')[0];
      const trimmed=line.trim();
      if(trimmed!==line){changed=true;}
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        rewrittenLines.push(line);
        return;
      }
      const sanitized=sanitizeDomain(trimmed);
      if (sanitized !== trimmed){changed=true;}
      rewrittenLines.push(sanitized);
      if(sanitized){domains.push(sanitized);}
    });

    const updatedContent=rewrittenLines.join('\n');

    if (changed && updatedContent !== contents) {
      try {
        fs.writeFileSync(filePath, updatedContent, 'utf8');
        console.log(`Normalized ${filetype} definition ${filename}`);
      } catch (writeError) {
        console.warn(`Could not rewrite ${filetype} definition ${filename} without protocol prefixes: ${writeError.message}`);
    } }
    if(domains.length){return domains;}
  } catch (error) {
    console.warn(`Could not read ${filetype} definition ${filename}: ${error.message}`);
  }

  // Fallback: infer from filename by stripping known extensions
  const base=filename.replace(/\.hts\.txt$/i, '').replace(/\.txt$/i, '');
  return base ? [base] : [];
}
async function parseDomainsOfKind(filePath,filename,filetype){let domains=[];
  if(filetype=='express'){domains=await parseExpressesDomains(filePath,filename,filetype);}
  else{domains=parseStaticsAndProxiesDomains(filePath,filename,filetype);}
  return domains;
}

async function loadDescriptorsOfKind(kind,PATTERN) {
  const result=[];const discovered=discoverFiles(PATTERN);
  for (const {absolutePath,displayName} of discovered) {
    let target=null;const domains=await parseDomainsOfKind(absolutePath,displayName,kind);
    if (kind==='proxy'){const parts=absolutePath.split('.');target=parts[parts.length - 3].trim();}
    result.push({type:kind,filename:displayName,absolutePath,domains,target});
  }
  return result;
}

/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # */
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # INTEGRATED APPS - START */
function shouldCompressStatic(req, res) {
  if(req.headers['x-no-compression']){return false;}
  const ext=path.extname(req.path || '').toLowerCase();
  const alreadyCompressed=new Set([
    '.jpg','.jpeg','.png','.gif','.webp','.ico','.svgz',
    '.zip','.gz','.bz2', '.rar', '.7z',
    '.mp4','.webm','.mov', '.avi', '.mp3', '.ogg', '.wav', '.aac', '.flac',
    '.pdf']);
  return !alreadyCompressed.has(ext);
}
function createAppOfKind(parameter,kind){
  if(kind=='proxy'){return createProxyApp(parameter);}
  else if(kind=='static'){return createStaticApp(parameter);}
}
function createProxyApp(target){
  const app=express();
  app.use(createProxyMiddleware({target:'http://localhost:'+target,changeOrigin:false}));
  return app;
}
function createStaticApp(rootDir) {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Static root ${rootDir} does not exist or is not a directory`);
  }
  const app=express();
  app.use(compression({ threshold: 0, filter: shouldCompressStatic }));
  // Serve index.html for directory requests if present.
  app.use((req, res, next)=>{
    const cleaned=req.path.replace(/\/+$/, '') || '/';
    const candidates=['index.html', 'index.htm', 'default.html', 'default.htm'];
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
  app.use(serveStatic(rootDir, {fallthrough:true,extensions:['html', 'htm']}));
  // Do not send 404 here so multiple static roots can be chained.
  // If this static root has no match, fall through to the next app.
  app.use((req, res, next)=>{next();});
  return app;
}
function createAppDescriptors(descriptors,buildApp,kind) {
  const results=[];
  descriptors.forEach((descriptor)=>{
    const {filename,domains}=descriptor;
    try {
      const app=buildApp(descriptor);
      results.push({filename,domains,app,kind});
    }
    catch(error){console.warn(`Skipping ${kind} ${filename}: ${error.message}`);}
  });
  return results;
}
function createProxyAppDescriptors(descriptors) {
  return createAppDescriptors(descriptors,({target})=>createAppOfKind(target,'proxy'),'proxy');
}
function createStaticAppDescriptors(descriptors) {
  return createAppDescriptors(descriptors,({absolutePath})=>createAppOfKind(path.dirname(absolutePath),'static'),'static');
}

/* INTEGRATED APPS - END # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # */
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # EXPRESS ROUTE MATCHING - START */
function getRequestPath(req){
  try {return new URL(req.url, 'http://localhost').pathname || '/';}
  catch {return '/';}
}

function createSimplePathMatcher(routePath){
  if(typeof routePath !== 'string'){return null;}
  // Normalize repeated slashes and trim trailing slash (except root).
  let normalized=routePath.replace(/\/+/g,'/');
  if(normalized.length>1){normalized=normalized.replace(/\/+$/,'');}
  if(normalized === '' || normalized === '*'){normalized='/';}

  const patternSegments=normalized.split('/').filter(Boolean);
  const isCatchAll=patternSegments.length===0;
  const hasWildcard=patternSegments.includes('*');

  return (requestPath)=>{
    if(typeof requestPath!=='string'){return false;}
    let p=requestPath.replace(/\/+/g,'/');
    if(p.length>1){p=p.replace(/\/+$/,'');}
    const pathSegments=p.split('/').filter(Boolean);
    if(isCatchAll){return true;}
    for(let i=0;i<patternSegments.length;i++){
      const seg=patternSegments[i];
      if(seg==='*'){return true;}
      const v=pathSegments[i];
      if(v===undefined){return false;}
      if(seg.startsWith(':')){continue;}
      if(seg!==v){return false;}
    }
    if(hasWildcard){return true;}
    return pathSegments.length===patternSegments.length;
  };
}

function extractExpressRouteMatchers(app){
  const matchers=[];
  const stack=
    (app && app._router && Array.isArray(app._router.stack) && app._router.stack) ||
    [];

  for(const layer of stack){
    const route=layer && layer.route;
    if(!route){continue;}
    const methodsObj=route.methods && typeof route.methods==='object' ? route.methods : {};
    const methods=new Set(
      Object.keys(methodsObj)
        .filter((k)=>methodsObj[k])
        .map((m)=>String(m).toUpperCase())
    );
    const paths=Array.isArray(route.path) ? route.path : [route.path];
    for(const routePath of paths){
      const matcher=createSimplePathMatcher(routePath);
      if(!matcher){continue;}
      matchers.push({ path: routePath, methods, matcher });
    }
  }
  return matchers;
}
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # EXPRESS ROUTE MATCHING - END */
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # CERTIFICATES - START */
function parseCertificateInfo(certBuffer, fallbackDomain) {
  const fallback=fallbackDomain ? [String(fallbackDomain).toLowerCase()] : [];
  if (!certBuffer) {return { domains: fallback, notAfterMs: 0, fingerprint: null };}
  try {
    const certificate=new X509Certificate(certBuffer);
    const altNames=certificate.subjectAltName
      ? certificate.subjectAltName
          .split(',')
          .map((entry)=>entry.trim())
          .filter((entry)=>entry.startsWith('DNS:'))
          .map((entry)=>entry.slice(4).toLowerCase())
      : [];

    // CN is a last-resort fallback when SANs are missing.
    let commonName=null;
    if (!altNames.length && certificate.subject) {
      const match=String(certificate.subject).match(/CN=([^,\/]+)/i);
      if (match && match[1]) {commonName=String(match[1]).trim().toLowerCase();}
    }

    const domains=altNames.length ? altNames : commonName ? [commonName] : fallback;
    const notAfterMs=Number.isFinite(Date.parse(certificate.validTo))
      ? Date.parse(certificate.validTo)
      : 0;
    const fingerprint=certificate.fingerprint256 || certificate.fingerprint || null;
    return { domains, notAfterMs, fingerprint };
  } catch (error) {
    console.warn(`Could not parse certificate info for ${fallbackDomain}: ${error.message}`);
  }
  return { domains: fallback, notAfterMs: 0, fingerprint: null };
}

function loadCertificateEntries() {
  if(!fs.existsSync(CERT_ROOT)){throw new Error(`Certificate directory ${CERT_ROOT} does not exist.`);}
  const directories=fs.readdirSync(CERT_ROOT, { withFileTypes: true }).filter((entry)=>entry.isDirectory());
  if (!directories.length) {throw new Error(`No certificates found under ${CERT_ROOT}.`);}
  const entries=[];
  directories.forEach((entry)=>{
    const certDir=path.join(CERT_ROOT, entry.name);
    const keyPath=path.join(certDir,'privkey.pem');
    const certPath=path.join(certDir,'cert.pem');
    const chainPath=path.join(certDir,'chain.pem');
    const key=readFileIfExists(keyPath);
    const cert=readFileIfExists(certPath);
    const ca=readFileIfExists(chainPath);
    if (!key || !cert) {
      console.warn(`Skipping certificate directory (missing privkey.pem or cert.pem): ${certDir}`);
      return;
    }
    const info=parseCertificateInfo(cert, entry.name);
    entries.push({
      key,cert,ca,
      domains: info.domains,
      notAfterMs: info.notAfterMs,
      fingerprint: info.fingerprint,
      source: certDir
    });
  });
  if (!entries.length) {throw new Error(`No usable certificates found under ${CERT_ROOT}.`);}
  return entries;
}

function domainMatchesPattern(domain, pattern) {
  const d=String(domain || '').toLowerCase();
  const p=String(pattern || '').toLowerCase();
  if (!d || !p) {return false;}
  if (p.startsWith('*.')) {
    const suffix=p.slice(1); // keep the leading dot for clarity
    return d.endsWith(suffix) && d.length > suffix.length;
  }
  return d === p;
}

function hasCertificateForDomain(domain,certEntries){
  return certEntries.some(({domains})=>domains.some((pattern)=>domainMatchesPattern(domain, pattern)));
}

/* CERTIFICATES - END # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # */
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # CERTIFICATE ASSOCIATION - START */
function scorePatternSpecificity(pattern){
  const p=String(pattern || '').toLowerCase();
  if(!p){return 0;}
  // Exact match always beats wildcard; longer names/suffixes beat shorter ones.
  if(p.startsWith('*.')){return 1000 + (p.length - 2);}
  return 2000 + p.length;
}

function selectBestCertificateForHostname(hostname, certEntries){
  const normalized=String(hostname || '').trim().toLowerCase();
  if(!normalized){return null;}

  let bestEntry=null;
  let bestPattern=null;
  let bestNotAfter=-1;
  let bestSpecificity=-1;

  for(const entry of certEntries){
    const entryNotAfter=Number(entry && entry.notAfterMs) || 0;
    for(const pattern of (entry.domains || [])){
      if(!domainMatchesPattern(normalized, pattern)){continue;}
      const specificity=scorePatternSpecificity(pattern);
      if(
        entryNotAfter > bestNotAfter ||
        (entryNotAfter === bestNotAfter && specificity > bestSpecificity)
      ){
        bestEntry=entry;
        bestPattern=pattern;
        bestNotAfter=entryNotAfter;
        bestSpecificity=specificity;
      }
    }
  }

  if(!bestEntry){return null;}
  return { entry: bestEntry, matchedPattern: bestPattern };
}

function createSniCertificateSelector(certEntries, options={}){
  const debug=!!options.debug;
  const contextCache=new Map(); // cacheKey -> SecureContext

  const cacheKeyForEntry=(entry)=>{
    const fp=entry && entry.fingerprint ? String(entry.fingerprint) : '';
    return `${entry && entry.source ? entry.source : ''}::${fp}`;
  };

  const getContextForEntry=(entry)=>{
    const key=cacheKeyForEntry(entry);
    const cached=contextCache.get(key);
    if(cached){return cached;}
    const context=tls.createSecureContext({ key: entry.key, cert: entry.cert, ca: entry.ca });
    contextCache.set(key, context);
    return context;
  };

  const primary=certEntries[0];
  const primaryContext=getContextForEntry(primary);

  const select=(servername)=>{
    const selection=selectBestCertificateForHostname(servername, certEntries);
    if(!selection){
      if(debug){console.log(`[SNI] ${servername} -> default (${primary.source})`);}
      return { entry: primary, matchedPattern: null, matched: false, context: primaryContext };
    }
    if(debug){
      console.log(`[SNI] ${servername} -> ${selection.matchedPattern} (${selection.entry.source})`);
    }
    return {
      entry: selection.entry,
      matchedPattern: selection.matchedPattern,
      matched: true,
      context: getContextForEntry(selection.entry)
    };
  };

  return {
    primary,
    select,
    hasMatch: (hostname)=>!!selectBestCertificateForHostname(hostname, certEntries)
  };
}

function describeBestCertificateForHostname(hostname, certEntries){
  const selection=selectBestCertificateForHostname(hostname, certEntries);
  if(!selection){return null;}
  const entry=selection.entry;
  const source=entry && entry.source ? path.basename(entry.source) : null;
  const expires=entry && entry.notAfterMs
    ? new Date(entry.notAfterMs).toISOString().slice(0, 10)
    : null;
  return { source, expires, matchedPattern: selection.matchedPattern };
}
/* CERTIFICATE ASSOCIATION - END # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # */
/* # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # CONFIG FILE - START */
function writeConfigFile(serverDescriptors, staticDescriptors, proxyDescriptors, certEntries){
  const lines=[];
  const pushEntry=(descriptor,type)=>{
    const { filename, absolutePath, domains, target }=descriptor;
    const id=absolutePath || path.join(__dirname, filename);
    lines.push(id);
    lines.push(`  type: ${type}`);
    lines.push(`  dir: ${path.dirname(id)}`);
    if(type === 'proxy' && target){lines.push(`  target: ${target}`);}
    lines.push('  domains:');
    if(!domains.length) {lines.push('    - (none) (cert: n/a)');} 
    else{
      domains.forEach((domain)=>{
        const certInfo=describeBestCertificateForHostname(domain, certEntries);
        const certStatus=certInfo
          ? `present; source=${certInfo.source || 'unknown'}; expires=${certInfo.expires || 'unknown'}; match=${certInfo.matchedPattern || 'unknown'}`
          : 'missing';
        lines.push(`    - ${domain} (cert: ${certStatus})`);
      });
    }
    lines.push('');
  };

  proxyDescriptors.forEach((descriptor)=>pushEntry(descriptor, 'proxy'));
  staticDescriptors.forEach((descriptor)=>pushEntry(descriptor, 'static'));
  serverDescriptors.forEach((descriptor)=>pushEntry(descriptor, 'express'));

  fs.writeFileSync(CONFIG_PATH, lines.join('\n'));
  console.log(`Wrote config summary to ${CONFIG_PATH}`);
}

function parseConfigFile() {
  if(!fs.existsSync(CONFIG_PATH)){return {servers:[],statics:[],proxies:[]};}
  const content=fs.readFileSync(CONFIG_PATH, 'utf8');
  const lines=content.split(/\r?\n/);
  const entries=[];let curr=null;
  const flush=()=>{if(curr&&curr.type&&curr.id){curr.domains=curr.domains||[];entries.push(curr);}curr=null;};
  lines.forEach((line)=>{
    if(!line.trim()){flush();return;}
    if (!line.startsWith(' ')) {flush();curr={id:line.trim(),domains:[]};return;}
    const trimmed=line.trim();
    if (trimmed.startsWith('type:')){curr.type=trimmed.split(':').slice(1).join(':').trim();return;}
    if (trimmed.startsWith('target:')){curr.target=trimmed.split(':').slice(1).join(':').trim();return;}
    if (trimmed.startsWith('dir:')){curr.dir=trimmed.split(':').slice(1).join(':').trim();return;}
    if (trimmed.startsWith('-')){
      const domainPart=trimmed.slice(1).trim();
      const withoutCert=domainPart.replace(/\(cert:.*\)$/i, '').trim();
      if (withoutCert && withoutCert !== '(none)') {
        curr.domains.push(withoutCert);
    } }
  });
  flush();

  const mapEntries=(type) =>
    entries
      .filter((e)=>e.type === type && e.id)
      .map((e)=>{
        const absolutePath=path.isAbsolute(e.id)
          ? e.id : e.dir
          ? path.join(e.dir, e.id)
          : path.join(__dirname, e.id);
        return {
          absolutePath,displayName:path.basename(absolutePath),
          domains:e.domains || [],
          target:e.target
        };
      });
  const proxies=mapEntries('proxy');
  const statics=mapEntries('static');
  const servers=mapEntries('express');
  return {servers,statics,proxies };
}

async function reconcileDescriptors({
  label,type,discovered,existingMap,
  finalList,seenSet,parseDomainsFromDisk}){
  for (const { filename, absolutePath, domains } of discovered) {
    var abs=false;
    try{abs=path.normalize(absolutePath);}
    catch(ex){console.log(filename);console.log(domains);console.log(discovered);throw ex;}
    seenSet.add(abs);
    const existingEntry=existingMap.get(abs);
    let effectiveDomains=domains;
    let target=false;
    if(type=='proxy'){
      target=absolutePath.split('.');
      target=target[target.length-3].trim();
    }
    if (existingEntry) {
      const stored=existingEntry.domains || [];
      const additions=effectiveDomains.filter((d)=>!stored.includes(d));
      const removals=stored.filter((d)=>!effectiveDomains.includes(d));
      if (additions.length || removals.length) {
        const answer=await askYesNo(
          `Update domains for ${label} ${abs}? existing: [${stored.join(', ')}], current: [${effectiveDomains.join(', ')}]`,
          true
        );
        if(!answer){effectiveDomains=stored;}
      }
    } else {
      const answer=await askYesNo(
        `Add new ${label} definition ${abs} with domains [${effectiveDomains.join(', ')}]?`,
        true
      );
      if(!answer){continue;}
    }
    let obj={type,filename,absolutePath:abs,domains:effectiveDomains};
    if(target){obj.target=target;}finalList.push(obj);
  }

  for (const [abs, entry] of existingMap.entries()) {
    if(seenSet.has(abs)){continue;}
    const keep=await askYesNo(
      `Config references ${label} ${abs} but it was not found in scan. Keep it?`,
      false
    );
    if(!keep){continue;}
    let domains=entry.domains || [];
    if(fs.existsSync(abs)){domains=await parseDomainsFromDisk(abs);}
    finalList.push({
      type,filename: entry.displayName || path.basename(abs),
      absolutePath:abs,domains,target
    });
  }
}

async function reconcileConfigInteractive() {
  const cfg = parseConfigFile();
  const kinds = [
    { label: 'proxy',   pattern: PROXY_PATTERN,   list: cfg.proxies },
    { label: 'static',  pattern: STATIC_PATTERN,  list: cfg.statics },
    { label: 'express', pattern: SERVERS_PATTERN, list: cfg.servers }
  ];
  const results={};
  for (const { label, pattern, list } of kinds) {
    const existingMap = new Map(list.map(s => [path.normalize(s.absolutePath), s]));
    const finalList=[];const seenSet=new Set();
    const discovered = await loadDescriptorsOfKind(label, pattern);
    await reconcileDescriptors({
      label,type:label,existingMap,discovered,finalList,seenSet,
      parseDomainsFromDisk: abs =>
        parseDomainsOfKind(abs, path.basename(abs), label)
    });
    results[label] = finalList;
  }
  return {serverDescriptors:results.express,staticDescriptors:results.static,proxiesDescriptors:results.proxy};
}

function buildDomainAppMap(serverDescriptors,staticAppDescriptors,proxyAppDescriptors=[]){
  const domainToApps=new Map();
  const attachDescriptors=(descriptors,kindOverride)=>{
    descriptors.forEach(({domains,app,filename,kind,matchers})=>{
      const effectiveKind=kindOverride || kind || 'express';
      (domains || []).forEach((domain)=>{
        const normalized=String(domain).trim().toLowerCase();
        if(!normalized){return;}
        const list=domainToApps.get(normalized) || [];
        list.push({ app, source: filename, kind: effectiveKind, matchers });
        domainToApps.set(normalized, list);
      });
    });
  };
  // Preserve existing priority: proxies, then statics, then express servers.
  attachDescriptors(proxyAppDescriptors,'proxy');
  attachDescriptors(staticAppDescriptors,'static');
  attachDescriptors(serverDescriptors,'express');
  return domainToApps;
}

function createRequestHandler(domainToApp, hasMatchingCertificate=()=>false) {
  return function httpsRequestHandler(req, res) {
    const hostHeader=req.headers.host || '';
    const hostname=hostHeader.split(':')[0].toLowerCase();
    const mappings=domainToApp.get(hostname);
    const requestPath=getRequestPath(req);
    const requestMethod=String(req.method || 'GET').toUpperCase();
    if(hasMatchingCertificate(hostname)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
      res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests');}
    if(!mappings || !mappings.length) {
      res.statusCode=502;res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('No application configured for this domain.');return;}
    let index=0;
    const runNextApp=()=>{
      if(res.headersSent){return;}
      if(index>=mappings.length){
        // Nothing handled the request for this domain.
        res.statusCode=404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }
      const mapping=mappings[index++];
      const { app, source }=mapping;
      if(mapping && mapping.kind==='express' && Array.isArray(mapping.matchers) && mapping.matchers.length){
        const matched=mapping.matchers.some((m)=>{
          if(m.methods && m.methods.size && !m.methods.has(requestMethod)){return false;}
          return m.matcher(requestPath);
        });
        if(!matched){runNextApp();return;}
      }
      try{
        // Always invoke apps with a next() handler so they can fall through.
        app(req, res, (err)=>{
          if(err){
            console.error(`Error handling request for ${hostname} via ${source}:`, err);
            if(!res.headersSent){
              res.statusCode=500;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end('Internal server error.');
            }
            return;
          }
          if(!res.headersSent){runNextApp();}
        });
      } catch(error){
        console.error(`Error handling request for ${hostname} via ${source}:`, error);
        if(!res.headersSent){runNextApp();}
      }
    };
    runNextApp();
  };
}

function reportCertificateCoverage(domainToApp, hasMatchingCertificate, primarySource){
  const uncovered=[];
  for(const domain of domainToApp.keys()){
    if(!hasMatchingCertificate(domain)){uncovered.push(domain);}
  }
  if(uncovered.length){
    console.warn(
      `No certificate matches these configured domains (default cert will be served: ${primarySource}): ${uncovered.join(', ')}`
    );
  }
}
async function main(options={}) {
  console.log(httpExpresses.HELP_TEXT);
  applyConfiguration(options);
  if(options.help||options.update){return;}
  let proxyDescriptors=[]; let staticDescriptors=[];let serverDescriptors=[];
  const parsed=parseConfigFile();
  const {servers,statics,proxies}=parsed;
  proxyDescriptors=proxies.map((item)=>({
    type:'proxy',filename:item.displayName,
    absolutePath:item.absolutePath,domains:item.domains||[],
    target:item.target || Math.floor(Math.random()*5000)+5000
  }));
  staticDescriptors=statics.map((item)=>({
    type:'static',filename:item.displayName,
    absolutePath:item.absolutePath,domains:item.domains||[],
  }));
  for (const spec of servers) {
    try {
      const descriptor=await loadServerDescriptor(spec.absolutePath);
      const domains=spec.domains && spec.domains.length ? spec.domains : descriptor.domains;
      serverDescriptors.push({ ...descriptor, filename: spec.displayName, absolutePath: spec.absolutePath, domains });
    } catch (error) {console.warn(`Skipping ${spec.displayName}: ${error.message}`);}
  }
  serverDescriptors=serverDescriptors.map((d)=>({
    ...d,
    matchers: extractExpressRouteMatchers(d.app)
  }));
  for (const descriptor of serverDescriptors) {
    if (descriptor && typeof descriptor.initModule === 'function') {
      try {
        await descriptor.initModule({
          app: descriptor.app,
          domains: descriptor.domains,
          meta: descriptor.meta,
          filename: descriptor.filename,
          absolutePath: descriptor.absolutePath
        });
      } catch (error) {
        console.error(`InitModule hook failed for ${descriptor.filename}:`, error);
      }
    }
  }
  let certificateEntries=loadCertificateEntries();
  const proxyApps=createProxyAppDescriptors(proxyDescriptors);
  const staticApps=createStaticAppDescriptors(staticDescriptors);
  const domainToApp=buildDomainAppMap(serverDescriptors, staticApps, proxyApps);
  const certificateSelector=createSniCertificateSelector(certificateEntries, {
    debug: !!process.env.HTS_DEBUG_CERTS
  });
  reportCertificateCoverage(domainToApp, certificateSelector.hasMatch, certificateSelector.primary.source);
  const httpsServer=https.createServer({
    key: certificateSelector.primary.key,
    cert: certificateSelector.primary.cert,
    ca: certificateSelector.primary.ca,
    SNICallback: (servername, cb) => {
      try {cb(null, certificateSelector.select(servername).context);}
      catch (error) {cb(error);}
    }
  }, createRequestHandler(domainToApp, certificateSelector.hasMatch));
  httpsServer.on('listening',()=>{console.log(`HTTPS server listening on port ${HTTPS_PORT}.`);});
  httpsServer.on('error',(error)=>{console.error('HTTPS server encountered an error:',error);});
  httpsServer.listen(HTTPS_PORT);
}

async function updateConfig(options){
  const ok=await reconcileConfigInteractive();
  const certificateEntries=loadCertificateEntries();
  writeConfigFile(ok.serverDescriptors,ok.staticDescriptors,ok.proxiesDescriptors, certificateEntries);
  console.log('Interactive update complete. Exiting (--update).');
  process.exit(0);
}

if (require.main === module) {
  const cliOptions=parseCliArgs(process.argv.slice(2));
  if(cliOptions.help){console.log(httpExpresses.HELP_TEXT);process.exit(0);}
  if(cliOptions.writeTemplate){
    try {writeTemplateFile(cliOptions.writeTemplate);process.exit(0);}
    catch(error){process.exit(1);}
  }
  if(cliOptions.update){updateConfig(cliOptions);}
  else{
    main(cliOptions).catch((error)=>{
      console.error(error.message || error);
      if (error && error.stack) {console.error(error.stack);}
      process.exitCode=1;
    });
  }
}

module.exports={ main };
