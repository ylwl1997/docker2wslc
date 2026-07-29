/** Compose migration analyser. Mirrors packages/py/src/docker2wslc/compose.py. */

import { parse as parseYaml } from 'yaml';
import { RULES } from './translate.js';

const KEYS = RULES.compose.keys;

function asList(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}=${v}`);
  return [String(value)];
}

// wslc rejects lowercase size units: `512m` -> "Invalid memory argument value".
function upperSize(v) {
  return String(v).replace(/^(\d+(?:\.\d+)?)\s*([kmgt])(b?)$/i,
    (_, n, u, b) => n + u.toUpperCase() + b.toUpperCase());
}

// --stop-timeout takes plain seconds; stop_grace_period is a Go duration.
// Compose allows compound forms like `1m30s`, so a single-unit regex is not
// enough -- `1m30s` must become 90, not pass through unchanged.
const UNIT_SECONDS = { h: 3600, m: 60, s: 1, ms: 0.001, us: 0.000001 };
function stopSeconds(v) {
  const raw = String(v).trim();
  if (/^\d+$/.test(raw)) return raw;
  const parts = [...raw.matchAll(/(\d+(?:\.\d+)?)(ms|us|h|m|s)/g)];
  if (!parts.length || parts.map((p) => p[1] + p[2]).join('') !== raw) return raw;
  const total = parts.reduce((acc, p) => acc + parseFloat(p[1]) * UNIT_SECONDS[p[2]], 0);
  return String(Math.round(total));
}

// Values are joined with spaces into one shell line, so anything containing
// whitespace or shell metacharacters must be quoted or the reader gets a command
// that silently splits into the wrong arguments.
function shellQuote(value) {
  const s = String(value);
  if (s === '') return "''";
  if (!/[\s"'$`\\|&;<>()*?!#~\[\]{}]/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Compose test: is a string (shell form) or an array led by CMD / CMD-SHELL / NONE.
function healthCmd(test) {
  if (!Array.isArray(test)) return String(test);
  const parts = test.map(String);
  const head = (parts[0] || '').toUpperCase();
  if (head === 'CMD-SHELL' || head === 'CMD') return parts.slice(1).join(' ');
  if (head === 'NONE') return '';
  return parts.join(' ');
}

function buildRun(name, svc) {
  const args = ['wslc', 'run', '-d', '--name', svc.container_name || name];

  for (const env of asList(svc.environment)) args.push('-e', shellQuote(env));
  for (const f of asList(svc.env_file)) args.push('--env-file', f);
  for (const p of asList(svc.ports)) args.push('-p', String(p).replace(/"/g, ''));
  for (const v of asList(svc.volumes)) args.push('-v', v);
  for (const n of asList(svc.networks)) args.push('--network', n);
  // cap_add / cap_drop / devices / privileged / security_opt / expose are
  // deliberately NOT emitted: wslc 2.9.4 has no such flags, so emitting them
  // yields "Argument name was not recognized". They surface as findings instead.
  for (const l of asList(svc.labels)) args.push('--label', shellQuote(l));
  for (const t of asList(svc.tmpfs)) args.push('--tmpfs', t);
  for (const d of asList(svc.dns)) args.push('--dns', String(d));
  for (const u of asList(svc.ulimits)) args.push('--ulimit', shellQuote(u));

  if (svc.working_dir) args.push('-w', String(svc.working_dir));
  if (svc.user) args.push('-u', String(svc.user));
  if (svc.hostname) args.push('--hostname', String(svc.hostname));
  if (svc.domainname) args.push('--domainname', String(svc.domainname));
  if (svc.shm_size) args.push('--shm-size', upperSize(svc.shm_size));
  if (svc.mem_limit) args.push('-m', upperSize(svc.mem_limit));
  if (svc.cpus) args.push('--cpus', String(svc.cpus));
  if (svc.stop_signal) args.push('--stop-signal', String(svc.stop_signal));
  if (svc.stop_grace_period) args.push('--stop-timeout', stopSeconds(svc.stop_grace_period));
  // healthcheck: maps flag-for-flag onto wslc run --health-* (verified 2.9.4.0).
  const hc = svc.healthcheck;
  if (hc && typeof hc === 'object') {
    if (hc.disable === true || hc.disable === 'true') {
      args.push('--no-healthcheck');
    } else {
      if (hc.test) args.push('--health-cmd', shellQuote(healthCmd(hc.test)));
      if (hc.interval) args.push('--health-interval', String(hc.interval));
      if (hc.retries) args.push('--health-retries', String(hc.retries));
      if (hc.timeout) args.push('--health-timeout', String(hc.timeout));
      if (hc.start_period) args.push('--health-start-period', String(hc.start_period));
    }
  }
  if (svc.entrypoint) {
    args.push('--entrypoint', shellQuote(Array.isArray(svc.entrypoint) ? svc.entrypoint.join(' ') : String(svc.entrypoint)));
  }
  if (svc.stdin_open) args.push('-i');
  if (svc.tty) args.push('-t');

  let image = svc.image;
  if (!image && svc.build) image = `${name}:local`;
  args.push(String(image || '<image>'));

  if (svc.command) {
    args.push(...(Array.isArray(svc.command) ? svc.command.map(String) : String(svc.command).split(' ')));
  }
  return args.join(' ');
}

export function analyse(text) {
  const report = { parseError: null, prelude: [], services: [] };

  let doc;
  try {
    doc = parseYaml(text) || {};
  } catch (err) {
    report.parseError = `YAML parse error: ${err.message}`;
    report.exitCode = 2;
    return report;
  }

  if (typeof doc !== 'object' || Array.isArray(doc)) {
    report.parseError = 'Compose file did not parse to a mapping.';
    report.exitCode = 2;
    return report;
  }

  for (const vol of Object.keys(doc.volumes || {})) report.prelude.push(`wslc volume create ${vol}`);
  for (const net of Object.keys(doc.networks || {})) report.prelude.push(`wslc network create ${net}`);

  const services = doc.services || {};
  if (typeof services !== 'object' || Array.isArray(services)) {
    report.parseError = '`services` is not a mapping.';
    report.exitCode = 2;
    return report;
  }

  let hasDependsOn = false;
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    const sr = { name, command: '', ok: [], partial: [], missing: [], unknown: [] };
    for (const key of Object.keys(svc)) {
      const spec = KEYS[key];
      if (!spec) sr.unknown.push(key);
      else if (spec.status === 'ok') sr.ok.push(key);
      else if (spec.status === 'partial') sr.partial.push({ key, note: spec.note || '' });
      else {
        sr.missing.push({ key, note: spec.note || '' });
        if (key === 'depends_on') hasDependsOn = true;
      }
    }
    sr.command = buildRun(name, svc);
    report.services.push(sr);
  }

  if (hasDependsOn) {
    report.prelude.push(`# start order matters: ${report.services.map((s) => s.name).join(' -> ')}`);
  }

  report.exitCode = report.services.some((s) => s.missing.length)
    ? 2
    : report.services.some((s) => s.partial.length)
      ? 1
      : 0;
  return report;
}
