'use strict';

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
