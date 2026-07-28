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

function buildRun(name, svc) {
  const args = ['wslc', 'run', '-d', '--name', svc.container_name || name];

  for (const env of asList(svc.environment)) args.push('-e', env);
  for (const f of asList(svc.env_file)) args.push('--env-file', f);
  for (const p of asList(svc.ports)) args.push('-p', String(p).replace(/"/g, ''));
  for (const v of asList(svc.volumes)) args.push('-v', v);
  for (const n of asList(svc.networks)) args.push('--network', n);
  for (const c of asList(svc.cap_add)) args.push('--cap-add', c);
  for (const d of asList(svc.devices)) args.push('--device', d);
  for (const l of asList(svc.labels)) args.push('--label', l);
  for (const t of asList(svc.tmpfs)) args.push('--tmpfs', t);

  if (svc.working_dir) args.push('-w', String(svc.working_dir));
  if (svc.user) args.push('-u', String(svc.user));
  if (svc.hostname) args.push('--hostname', String(svc.hostname));
  if (svc.entrypoint) {
    args.push('--entrypoint', Array.isArray(svc.entrypoint) ? svc.entrypoint.join(' ') : String(svc.entrypoint));
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
