#!/usr/bin/env node

/**
 * The `pgtyped` bin, and the only module in this package with side effects at
 * import time.
 *
 * It used to be `index.ts`, which is also the package's library entry point,
 * so importing anything from the package ran argv parsing and `process.exit`
 * in the *importing* process: `import('@pelotech/pgtyped-cli/generator.js')`
 * printed the CLI's --help and "Missing required argument: config" and exited
 * the host. Keeping the two apart is what makes the `"."` export usable.
 */

import chokidar from 'chokidar';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { parseConfig } from './config.js';
import { main } from './index.js';
import { fatal } from './util.js';

// tslint:disable:no-console

const args = yargs(hideBin(process.argv))
  .version()
  // Prefixed. `.env()` with no prefix mapped every option onto a bare
  // environment variable, so an ambient `FILE` — a common enough name in a
  // Makefile or a shell function — set `--file` and the run quietly generated
  // nothing, or refused to start in watch mode (#579).
  .env('PGTYPED')
  .options({
    config: {
      alias: 'c',
      type: 'string',
      description: 'Config file path',
      demandOption: true,
    },
    watch: {
      alias: 'w',
      description: 'Watch mode',
      type: 'boolean',
    },
    uri: {
      type: 'string',
      description: 'DB connection URI (overrides config)',
    },
    file: {
      alias: 'f',
      type: 'string',
      conflicts: 'watch',
      description: 'File path (process single file, incompatible with --watch)',
    },
  })
  .epilogue('For more information, find our manual at https://pgtyped.dev/')
  .parseSync();

const {
  watch: isWatchMode,
  file: fileOverride,
  config: configPath,
  uri: connectionUri,
} = args;

if (typeof configPath !== 'string') {
  fatal('Config file required. See help -h for details.\nExiting.');
}

if (isWatchMode && fileOverride) {
  fatal('File override is not compatible with watch mode.\nExiting.');
}

try {
  // Watch mode only. A one-shot run holds no long-lived state that a config
  // edit could invalidate, and watching from one anyway meant a build step
  // that rewrote the config while codegen ran — templating in a connection
  // string, say — killed the run mid-flight: exit 0, nothing written, green
  // CI, no generated types (#609, #616).
  if (isWatchMode) {
    chokidar.watch(configPath, {}).on('change', () => {
      // Not a failure: the config the run was started with is gone, so the run
      // ends deliberately and the user (or their supervisor process) restarts
      // it against the new one. Exiting non-zero here would report a broken
      // build every time someone edited the config in watch mode.
      console.log('Config file changed. Exiting.');
      process.exit(0);
    });
  }
  const config = parseConfig(configPath, connectionUri);
  main(config, isWatchMode || false, fileOverride)
    .then((code) => {
      // `undefined` is watch mode, which does not end: the pool and the file
      // watchers keep the process alive until something else stops it.
      if (code !== undefined) {
        process.exit(code);
      }
    })
    .catch((e) => fatal('Codegen failed:', e));
} catch (e) {
  fatal('Failed to parse config file:', e);
}
