/**
 * Docker -> wslc translation, driven by the shared rules.json.
 * Keep behaviour in lockstep with packages/py/src/docker2wslc/translate.py.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const RULES = require('../rules.json');

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

// Verbs where wslc also accepts the docker-style top-level form, so rewriting
// to the noun form is cosmetic rather than required. Verified on wslc 2.9.4.
const ALIAS_OK = new Set(Object.keys((RULES.renamedOptional || {}).commands || {}));
const SEV_ORDER = { info: 0, warn: 1, error: 2 };

export function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of line) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function flagSpec(flag) {
  const flags = RULES.flags;
  if (flags[flag]) return [flag, flags[flag]];
  for (const [canonical, spec] of Object.entries(flags)) {
    if ((spec.aliases || []).includes(flag)) return [canonical, spec];
  }
  return [null, null];
}

function translateArgs(args, notes) {
  const out = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const bare = eq > -1 ? arg.slice(0, eq) : arg;
    const inline = eq > -1 ? arg.slice(eq + 1) : null;
    const [, spec] = flagSpec(bare);

    if (!spec) { out.push(arg); i += 1; continue; }

    const takesValue = Boolean(spec.takesValue);
    const hasInline = eq > -1;
    const value = hasInline ? inline : (args[i + 1] ?? '');
    const consumed = hasInline || !takesValue ? 1 : 2;

    if (spec.action === 'conditional') {
      const branch = (spec.whenValue || {})[value];
      if (branch && branch.action === 'drop') {
        notes.push({ severity: branch.severity || 'info', text: branch.note });
        i += consumed;
        continue;
      }
      if (branch && branch.action === 'error') {
        // Value is kept so the reader sees what they wrote, but flagged as an
        // error: wslc rejects it outright.
        notes.push({ severity: branch.severity || 'error', text: branch.note });
        out.push(hasInline ? `${bare}=${value}` : bare);
        if (!hasInline && takesValue && value) out.push(value);
        i += consumed;
        continue;
      }
      notes.push({ severity: spec.severity || 'info', text: spec.note });
      if (hasInline) out.push(`${bare}=${value}`);
      else { out.push(bare); if (takesValue && value) out.push(value); }
      i += consumed;
      continue;
    }

    if (spec.action === 'drop') {
      notes.push({ severity: spec.severity || 'warn', text: spec.note });
      i += consumed;
      continue;
    }

    if (spec.action === 'rewrite') {
      notes.push({ severity: spec.severity || 'info', text: spec.note });
      out.push(...spec.replaceWith.split(' '));
      i += consumed;
      continue;
    }

    // keep
    if (spec.noteWhenWindowsPath && (WINDOWS_PATH.test(value) || value.startsWith('/mnt/'))) {
      notes.push({ severity: spec.severity || 'info', text: spec.noteWhenWindowsPath });
    }
    // Some flags exist but reject certain value formats (verified: wslc wants
    // uppercase size units, so `-m 512m` fails while `512M` works).
    if (spec.requireValuePattern && value && !new RegExp(spec.requireValuePattern).test(value)) {
      notes.push({ severity: 'error', text: spec.noteWhenValueRejected });
    }
    if (spec.noteAlways) {
      notes.push({ severity: spec.severity || 'info', text: spec.noteAlways });
    }
    out.push(arg);
    if (!hasInline && takesValue && value) out.push(value);
    i += consumed;
  }
  return out;
}

export function exitCodeFor({ notes, composeHit, unsupportedHit }) {
  if (unsupportedHit || composeHit) return 2;
  if (notes.some((n) => n.severity === 'warn' || n.severity === 'error')) return 1;
  return 0;
}

export function translateLine(raw) {
  const line = raw.trim();
  if (!line) return null;
  if (line.startsWith('#')) return { output: line, notes: [] };

  const notes = [];
  const tokens = tokenize(line);

  if (tokens[0] === 'sudo') {
    tokens.shift();
    notes.push({
      severity: 'info',
      text: 'Dropped sudo — wslc runs as your Windows user, no elevation needed for normal container operations.',
    });
  }

  if (!tokens.length || (tokens[0] !== 'docker' && tokens[0] !== 'podman')) {
    return {
      output: `# not a docker command: ${line}`,
      notes: [{ severity: 'info', text: 'Only docker/podman commands are translated. Line left unchanged.' }],
    };
  }

  if (tokens[0] === 'podman') {
    notes.push({ severity: 'info', text: 'Treated podman as Docker-compatible; flag coverage is nearly identical.' });
  }
  tokens.shift();

  if (!tokens.length) return { output: 'wslc', notes };

  if (tokens[0] === 'compose' || tokens[0] === 'docker-compose') {
    notes.push({ severity: 'error', text: RULES.compose.note });
    return { output: '# No native Compose runtime in wslc.', notes, composeHit: true };
  }

  const two = tokens.length > 1 ? `${tokens[0]} ${tokens[1]}` : '';
  // Two-word forms with a verified verdict of their own (e.g. `docker system
  // prune` has no wslc equivalent, but the per-noun prunes do).
  const twoWord = RULES.twoWord || {};
  if (two && twoWord[two]) {
    const entry = twoWord[two];
    if (entry.status === 'unsupported') {
      notes.push({ severity: 'error', text: entry.note });
      return { output: `# ${two}: not supported by wslc`, notes, unsupportedHit: true };
    }
    notes.push({ severity: 'info', text: entry.note });
    const rest = translateArgs(tokens.slice(2), notes);
    return { output: ['wslc', two, ...rest].join(' ').trim(), notes };
  }
  if (two && Object.values(RULES.renamed).includes(two)) {
    const rest = translateArgs(tokens.slice(2), notes);
    return { output: ['wslc', two, ...rest].join(' ').trim(), notes };
  }

  const verb = tokens[0];

  if (RULES.unsupported[verb]) {
    notes.push({ severity: 'error', text: RULES.unsupported[verb] });
    return { output: `# ${verb}: not supported by wslc`, notes, unsupportedHit: true };
  }

  if (RULES.renamed[verb]) {
    const mapped = RULES.renamed[verb];
    const flagMap = RULES.renamedFlags[verb] || {};
    const rest = translateArgs(tokens.slice(1).map((a) => flagMap[a] || a), notes);
    notes.push({
      severity: 'info',
      text: `\`docker ${verb}\` is grouped under a noun in wslc: \`wslc ${mapped}\`. ` + (ALIAS_OK.has(verb)
        ? `\`wslc ${verb}\` also works as a top-level alias (verified on 2.9.4), so this rewrite is cosmetic.`
        : `There is no top-level \`wslc ${verb}\`; the noun form is required.`),
    });
    return { output: ['wslc', mapped, ...rest].join(' ').trim(), notes };
  }

  if (RULES.identical.includes(verb)) {
    const rest = translateArgs(tokens.slice(1), notes);
    return { output: ['wslc', verb, ...rest].join(' ').trim(), notes };
  }

  notes.push({
    severity: 'warn',
    text: `Unknown docker subcommand \`${verb}\` — passed through unchanged. Verify against \`wslc --help\`.`,
  });
  const rest = translateArgs(tokens.slice(1), notes);
  return { output: ['wslc', verb, ...rest].join(' ').trim(), notes };
}

export function translate(text) {
  const lines = [];
  const notes = [];
  const seen = new Set();
  let composeHit = false;
  let unsupportedHit = false;

  for (const raw of String(text).split('\n')) {
    const res = translateLine(raw);
    if (!res) { lines.push(''); continue; }
    lines.push(res.output);
    composeHit = composeHit || Boolean(res.composeHit);
    unsupportedHit = unsupportedHit || Boolean(res.unsupportedHit);
    for (const note of res.notes) {
      if (!seen.has(note.text)) { seen.add(note.text); notes.push(note); }
    }
  }

  notes.sort((a, b) => (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0));
  const result = {
    output: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    notes,
    composeHit,
    unsupportedHit,
  };
  result.exitCode = exitCodeFor(result);
  return result;
}
