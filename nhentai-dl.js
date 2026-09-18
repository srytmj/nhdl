#!/usr/bin/env node

/**
 * NHDL Router (Backward Compatibility Wrapper)
 * Automatically delegates execution to either the Web App Daemon or the Standalone CLI.
 */

const args = process.argv.slice(2);

if (args.includes('--server') || process.env.WEB_GUI === 'true') {
    require('./server/index.js');
} else {
    require('./cli/index.js');
}
