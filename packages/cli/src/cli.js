#!/usr/bin/env node
/** docker2wslc CLI. Docs: https://wslcontainers.com */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

import { analyse } from './compose.js';
import { RULES, translate } from './translate.js';

const VERSION = '0.2.0';
const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const SEV_COLOR = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';

let useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (s, c) => (useColor && c ? `${c}${s}${RESET}` : s);

function readInput(file) {
  if (!file || file === '-') return readFileSync(0, 'utf-8');
  return readFileSync(file, 'utf-8');
}

function usage() {
  return `docker2wslc ${VERSION} — translate Docker commands and Compose files to wslc

Usage:
  docker2wslc convert <docker command...>   translate a command
  docker2wslc convert -f <file|->          translate a script or stdin
  docker2wslc compose [file]               analyse a compose file
  docker2wslc lint [path]                  scan a repo for incompatibilities

Options:
  --json        machine-readable output
  -q, --quiet   suppress migration notes
  --no-color    disable ANSI colour
  -h, --help    show this help
  -v, --version show version

Exit codes: 0 clean, 1 degraded, 2 unmigratable.
Docs: ${RULES.links.site}`;
}

function printNotes(notes, composeHit) {
  if (!notes.length) return;
  process.stderr.write(`\n${paint('Migration notes', BOLD)}\n`);
  for (const n of notes) {
    const tag = paint(n.severity.toUpperCase().padEnd(5), SEV_COLOR[n.severity]);
    process.stderr.write(`  ${tag} ${n.text}\n`);
  }
  if (composeHit) process.stderr.write(`\n  See ${RULES.links.compose}\n`);
}

function cmdConvert(args, opts) {
  const text = args.length ? args.join(' ') : readInput(opts.file);
  const res = translate(text);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res.exitCode;
  }
  process.stdout.write(`${res.output}\n`);
  if (!opts.quiet) printNotes(res.notes, res.composeHit);
  return res.exitCode;
}

function cmdCompose(args, opts) {
  const file = args[0] || 'docker-compose.yml';
  const report = analyse(readFileSync(file, 'utf-8'));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.exitCode;
  }
  if (report.parseError) {
    process.stderr.write(`${paint(`error: ${report.parseError}`, SEV_COLOR.error)}\n`);
    return report.exitCode;
  }
  process.stdout.write(`${paint('# wslc has no Compose runtime. Equivalent commands:', DIM)}\n`);
  if (report.prelude.length) {
    process.stdout.write(`\n${report.prelude.join('\n')}\n`);
  }
  for (const svc of report.services) {
    process.stdout.write(`\n${paint(`# service: ${svc.name}`, BOLD)}\n${svc.command}\n`);
    for (const { key, note } of svc.partial) {
      process.stderr.write(`${paint(`  ! ${key}: ${note}`, SEV_COLOR.warn)}\n`);
    }
    for (const { key, note } of svc.missing) {
      process.stderr.write(`${paint(`  x ${key}: ${note}`, SEV_COLOR.error)}\n`);
    }
    if (svc.unknown.length) {
      process.stderr.write(`${paint(`  ? unrecognised keys: ${svc.unknown.join(', ')}`, DIM)}\n`);
    }
  }
  process.stderr.write(`\n${paint('Guide:', DIM)} ${RULES.links.compose}\n`);
  return report.exitCode;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    // readdir surfaces dot-directories, so .devcontainer/ is covered here.
    if (entry.isDirectory()) walk(full, out);
    else if (COMPOSE_NAMES.includes(entry.name) || entry.name === 'devcontainer.json') out.push(full);
  }
  return out;
}

function lintDevcontainer(path, label) {
  const keys = RULES.devcontainer.keys;
  let doc;
  try {
    const raw = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    doc = JSON.parse(raw);
  } catch (err) {
    process.stdout.write(`${paint(`${label}: cannot parse (${err.message})`, SEV_COLOR.error)}\n`);
    return 2;
  }
  let code = 0;
  let header = false;
  for (const key of Object.keys(doc)) {
    const spec = keys[key];
    if (!spec || spec.status === 'ok') continue;
    if (!header) { process.stdout.write(`${paint(label, BOLD)}\n`); header = true; }
    if (spec.status === 'missing') {
      process.stdout.write(`${paint(`  x ${key}: ${spec.note || 'unsupported'}`, SEV_COLOR.error)}\n`);
      code = 2;
    } else {
      process.stdout.write(`${paint(`  ! ${key}: ${spec.note || 'differs'}`, SEV_COLOR.warn)}\n`);
      code = Math.max(code, 1);
    }
  }
  return code;
}

function cmdLint(args) {
  const root = args[0] || '.';
  const isFile = statSync(root).isFile();
  const files = isFile ? [root] : walk(root).sort();
  if (!files.length) {
    process.stderr.write('No compose or devcontainer files found.\n');
    return 0;
  }
  let worst = 0;
  for (const path of files) {
    const label = isFile ? path : relative(root, path).split(sep).join('/');
    if (path.endsWith('devcontainer.json')) {
      worst = Math.max(worst, lintDevcontainer(path, label));
      continue;
    }
    const report = analyse(readFileSync(path, 'utf-8'));
    const issues = [
      ...report.services.flatMap((s) => s.missing.map((m) => ({ ...m, mark: 'x' }))),
      ...report.services.flatMap((s) => s.partial.map((m) => ({ ...m, mark: '!' }))),
    ];
    if (issues.length) {
      process.stdout.write(`${paint(label, BOLD)}\n`);
      for (const { key, note, mark } of issues) {
        const col = mark === 'x' ? SEV_COLOR.error : SEV_COLOR.warn;
        process.stdout.write(`${paint(`  ${mark} ${key}: ${note}`, col)}\n`);
      }
    }
    worst = Math.max(worst, report.exitCode);
  }
  if (worst === 0) process.stdout.write(`${paint('All checked files are wslc-compatible.', GREEN)}\n`);
  return worst;
}

function main(argv) {
  const opts = { json: false, quiet: false, file: null };
  const rest = [];
  let passthroughFrom = -1;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // Everything from the first docker/podman/sudo token is the command to
    // translate — do not parse its flags as our own.
    if (passthroughFrom === -1 && (a === 'docker' || a === 'podman' || a === 'sudo')) {
      passthroughFrom = i;
      break;
    }
    if (a === '--json') opts.json = true;
    else if (a === '-q' || a === '--quiet') opts.quiet = true;
    else if (a === '--no-color') useColor = false;
    else if (a === '-f' || a === '--file') { opts.file = argv[i + 1]; i += 1; }
    else if (a === '-h' || a === '--help') { process.stdout.write(`${usage()}\n`); return 0; }
    else if (a === '-v' || a === '--version') { process.stdout.write(`docker2wslc ${VERSION}\n`); return 0; }
    else rest.push(a);
  }

  const cmd = rest.shift();
  const args = passthroughFrom > -1 ? argv.slice(passthroughFrom) : rest;

  if (!cmd) { process.stderr.write(`${usage()}\n`); return 2; }

  try {
    if (cmd === 'convert') return cmdConvert(args, opts);
    if (cmd === 'compose') return cmdCompose(args, opts);
    if (cmd === 'lint') return cmdLint(args);
    process.stderr.write(`error: unknown command '${cmd}'\n\n${usage()}\n`);
    return 2;
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stderr.write(`error: ${err.path}: no such file\n`);
      return 2;
    }
    if (err.code === 'EPIPE') return 0;
    throw err;
  }
}

process.exitCode = main(process.argv.slice(2));
