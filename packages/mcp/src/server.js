#!/usr/bin/env node
/**
 * wslc MCP server — exposes Docker->wslc translation and migration analysis
 * to MCP clients (Claude Code, Cursor, Windsurf, Zed).
 *
 * Transport: stdio. Docs: https://wslcontainers.com
 */

import { createRequire } from 'node:module';
import process from 'node:process';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { analyse } from './compose.js';
import { RULES, translate } from './translate.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

const TOOLS = [
  {
    name: 'convert_docker_command',
    description:
      'Translate a Docker (or Podman) command into its wslc equivalent for WSL containers on ' +
      'Windows 11. Returns the converted command plus migration notes for flags that are ' +
      'dropped, rewritten or behave differently. Use this whenever a user asks how to run a ' +
      'docker command with wslc, or how to drop Docker Desktop.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The docker command or multi-line shell script to translate.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'analyze_compose',
    description:
      'Analyse a docker-compose.yml for migration to wslc. wslc has NO Compose runtime, so this ' +
      'returns an equivalent `wslc run` command per service, the volume/network commands to run ' +
      'first, and every Compose key that cannot be carried over (depends_on, healthcheck, ' +
      'restart, deploy). Use when a user wants to migrate a Compose stack.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full text of the docker-compose.yml file.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'check_tool_compatibility',
    description:
      'Check whether a developer tool works with wslc. The rule: CLI-driven tooling ports to ' +
      'wslc, API-driven tooling does not, because wslc is daemonless and exposes no Docker ' +
      'Engine API or socket. Use for questions like "does Testcontainers/Portainer/act work ' +
      'with wslc".',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Tool name, e.g. "Testcontainers", "Portainer", "VS Code Dev Containers".',
        },
      },
      required: ['tool'],
    },
  },
  {
    name: 'check_devcontainer',
    description:
      'Check a devcontainer.json for wslc compatibility and explain the required VS Code ' +
      'setting (dev.containers.dockerPath = wslc). Flags keys that cannot work, such as ' +
      'dockerComposeFile and features.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full text of devcontainer.json (comments allowed).' },
      },
      required: ['content'],
    },
  },
  {
    name: 'get_wslc_limitations',
    description:
      'List the known limitations of the wslc preview compared to Docker: no Compose runtime, ' +
      'no restart policies, no --platform, no Docker socket/Engine API, no ' +
      'buildx, and the run flags wslc lacks. Use when a user asks what they give up by switching from Docker Desktop.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function handleConvert({ command }) {
  if (typeof command !== 'string' || !command.trim()) {
    return textResult('error: `command` must be a non-empty string.', true);
  }
  const r = translate(command);
  const lines = [r.output];
  if (r.notes.length) {
    lines.push('', 'Migration notes:');
    for (const n of r.notes) lines.push(`- [${n.severity}] ${n.text}`);
  }
  const verdict = { 0: 'compatible', 1: 'degraded (flags changed)', 2: 'not migratable' }[r.exitCode];
  lines.push('', `Verdict: ${verdict}`);
  if (r.composeHit) lines.push(`Compose migration guide: ${RULES.links.compose}`);
  lines.push(`Reference: ${RULES.links.cheatsheet}`);
  return textResult(lines.join('\n'));
}

function handleCompose({ content }) {
  if (typeof content !== 'string' || !content.trim()) {
    return textResult('error: `content` must be a non-empty string.', true);
  }
  const rep = analyse(content);
  if (rep.parseError) return textResult(`error: ${rep.parseError}`, true);

  const lines = ['wslc has no Compose runtime. Equivalent commands:', ''];
  if (rep.prelude.length) lines.push(...rep.prelude, '');
  for (const svc of rep.services) {
    lines.push(`# service: ${svc.name}`, svc.command);
    for (const { key, note } of svc.missing) lines.push(`  BLOCKED ${key}: ${note}`);
    for (const { key, note } of svc.partial) lines.push(`  CAUTION ${key}: ${note}`);
    if (svc.unknown.length) lines.push(`  UNKNOWN keys: ${svc.unknown.join(', ')}`);
    lines.push('');
  }
  const verdict = { 0: 'fully migratable', 1: 'migratable with caveats', 2: 'has blocking keys' }[rep.exitCode];
  lines.push(`Verdict: ${verdict}`, `Guide: ${RULES.links.compose}`);
  return textResult(lines.join('\n'));
}

function handleToolCompat({ tool }) {
  if (typeof tool !== 'string' || !tool.trim()) {
    return textResult('error: `tool` must be a non-empty string.', true);
  }
  const needle = tool.toLowerCase();
  const known = RULES.apiIncompatible.tools;
  const hit =
    known.find((t) => t.name.toLowerCase() === needle) ||
    known.find((t) => t.name.toLowerCase().includes(needle) || needle.includes(t.name.toLowerCase()));

  const lines = [];
  if (hit) {
    lines.push(
      `${hit.name}: ${hit.works ? 'WORKS with wslc' : 'does NOT work with wslc'}`,
      `Reason: talks to the runtime via ${hit.via}.`,
      '',
    );
    if (!hit.works && /testcontainers/i.test(hit.name)) {
      lines.push(
        'No configuration fixes this — there is no endpoint for DOCKER_HOST to point at, and',
        'aliasing docker to wslc does not help because the client opens a socket rather than',
        'shelling out. Workaround: install Docker Engine (docker-ce) inside a normal WSL2 distro.',
        `Details: ${RULES.links.testcontainers}`,
        '',
      );
    }
    if (hit.works && /dev containers/i.test(hit.name)) {
      const s = RULES.devcontainer.requiredSetting;
      lines.push(`Set \`${s.key}\` to \`${s.value}\`. ${s.note}`, `Details: ${RULES.links.devcontainers}`, '');
    }
  } else {
    lines.push(`"${tool}" is not in the known list. Apply the general rule:`, '');
  }
  lines.push(
    RULES.apiIncompatible.note,
    '',
    'Known results:',
    ...known.map((t) => `  ${t.works ? 'works ' : 'blocked'} — ${t.name} (${t.via})`),
  );
  return textResult(lines.join('\n'));
}

function handleDevcontainer({ content }) {
  if (typeof content !== 'string' || !content.trim()) {
    return textResult('error: `content` must be a non-empty string.', true);
  }
  let doc;
  try {
    doc = JSON.parse(
      content.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'),
    );
  } catch (err) {
    return textResult(`error: cannot parse devcontainer.json (${err.message})`, true);
  }
  const keys = RULES.devcontainer.keys;
  const s = RULES.devcontainer.requiredSetting;
  const blocked = [];
  const caution = [];
  for (const key of Object.keys(doc)) {
    const spec = keys[key];
    if (!spec || spec.status === 'ok') continue;
    (spec.status === 'missing' ? blocked : caution).push(`${key}: ${spec.note || ''}`);
  }
  const lines = [`Required VS Code setting: "${s.key}": "${s.value}"`, s.note, ''];
  if (blocked.length) lines.push('BLOCKED (will not work with wslc):', ...blocked.map((b) => `  - ${b}`), '');
  if (caution.length) lines.push('CAUTION (behaves differently):', ...caution.map((c) => `  - ${c}`), '');
  if (!blocked.length && !caution.length) lines.push('No wslc incompatibilities found in this devcontainer.json.', '');
  lines.push(`Guide: ${RULES.links.devcontainers}`);
  return textResult(lines.join('\n'));
}

function handleLimitations() {
  const lines = [
    'wslc preview limitations vs Docker:',
    '',
    '- No Compose runtime — translate services to individual wslc run calls',
    '- No restart policies — --restart is rejected, and there is no wslc restart either (stop then start)',
    '- No --platform — host architecture only',
    '- No Docker socket or Engine API — Testcontainers, Portainer, act cannot attach',
    '- No buildx / bake — single-platform wslc build only',
    '- No Swarm (service, stack, node, secret, config)',
    '- No --device, --cap-add, --cap-drop, --privileged, --security-opt or --expose',
    '- No --network host (rejected: "host mode networking is not supported"); --network none works',
    '- Missing subcommands: restart, pause, unpause, top, wait, port, rename, diff, commit, info, image history, image search, system prune/df/info',
    '- Windows paths shared over VirtioFS — use forward slashes',
    '',
    'Things that DO work and must not be called missing:',
    '- --gpus is native, exactly as in Docker (--gpus all). It is --device that does NOT exist.',
    '- Health checks on wslc run: --health-cmd, --health-interval, --health-retries,',
    '  --health-start-period, --health-timeout, --no-healthcheck. What is missing is a',
    '  Compose runtime to read a healthcheck: block, not the feature itself.',
    '- --tmpfs, --ulimit, --shm-size, -m/--memory, --cpus, -P, --stop-signal, --stop-timeout, --dns, --cidfile',
    '- Per-noun prune: wslc container/image/volume/network prune',
    '- Memory units must be UPPERCASE: 512m is rejected, 512M works',
    '',
    'Verb renames: ' +
      Object.entries(RULES.renamed).map(([k, v]) => `docker ${k} -> wslc ${v}`).join(', '),
    '',
    RULES.apiIncompatible.note,
    '',
    `Rules target the ${RULES.wslcPreview} preview. Docs: ${RULES.links.site}`,
  ];
  return textResult(lines.join('\n'));
}

const HANDLERS = {
  convert_docker_command: handleConvert,
  analyze_compose: handleCompose,
  check_tool_compatibility: handleToolCompat,
  check_devcontainer: handleDevcontainer,
  get_wslc_limitations: handleLimitations,
};

const server = new Server(
  { name: 'wslc', version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) return textResult(`error: unknown tool '${req.params.name}'`, true);
  try {
    return handler(req.params.arguments || {});
  } catch (err) {
    return textResult(`error: ${err.message}`, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`wslc MCP server ${VERSION} ready on stdio\n`);
