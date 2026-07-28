/** Assertive MCP tests: one server process, real stdio JSON-RPC, real assertions. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let proc;
let buf = '';
const seen = new Map();
let nextId = 100;

const send = (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`);

async function rpc(method, params, timeout = 8000) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (seen.has(id)) return seen.get(id);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${method} (id=${id})`);
}

const callText = async (name, args) => {
  const res = await rpc('tools/call', { name, arguments: args });
  return {
    text: res.result?.content?.[0]?.text ?? '',
    isError: Boolean(res.result?.isError),
  };
};

before(async () => {
  proc = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: ROOT,
  });
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) seen.set(msg.id, msg);
      } catch { /* partial frame */ }
    }
  });
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'node-test', version: '1' },
  });
  assert.equal(init.result.serverInfo.name, 'wslc');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

after(() => { if (proc) proc.kill(); });

test('tools/list exposes all five tools with schemas', async () => {
  const res = await rpc('tools/list', {});
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'analyze_compose',
    'check_devcontainer',
    'check_tool_compatibility',
    'convert_docker_command',
    'get_wslc_limitations',
  ]);
  for (const tool of res.result.tools) {
    assert.ok(tool.description?.length > 20, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('convert_docker_command rewrites --gpus and drops --restart', async () => {
  const { text, isError } = await callText('convert_docker_command', {
    command: 'docker run --gpus all --restart always -p 8080:80 nginx',
  });
  assert.equal(isError, false);
  assert.match(text, /wslc run --device nvidia\.com\/gpu=all -p 8080:80 nginx/);
  assert.match(text, /[Rr]estart polic/);
  assert.match(text, /degraded/i);
});

test('convert_docker_command marks compose as unmigratable', async () => {
  const { text } = await callText('convert_docker_command', { command: 'docker compose up -d' });
  assert.match(text, /No native Compose runtime/i);
  assert.match(text, /not migratable/i);
});

test('convert_docker_command translates plain verbs cleanly', async () => {
  const { text } = await callText('convert_docker_command', { command: 'docker ps -a' });
  assert.match(text, /wslc container list --all/);
});

test('convert_docker_command rejects empty input', async () => {
  const { text, isError } = await callText('convert_docker_command', { command: '' });
  assert.equal(isError, true);
  assert.match(text, /non-empty string/);
});

test('analyze_compose emits run commands and flags blockers', async () => {
  const { text } = await callText('analyze_compose', {
    content: 'services:\n  web:\n    image: nginx\n    ports: ["80:80"]\n    restart: always\n    depends_on: [db]\n  db:\n    image: postgres:16\n    healthcheck:\n      test: ["CMD", "pg_isready"]\n',
  });
  assert.match(text, /wslc run/);
  assert.match(text, /nginx/);
  assert.match(text, /postgres:16/);
  assert.match(text, /restart/);
  assert.match(text, /depends_on/);
  assert.match(text, /healthcheck/);
});

test('analyze_compose errors on malformed yaml', async () => {
  const { isError, text } = await callText('analyze_compose', { content: 'services: [oops' });
  assert.ok(isError || /error|parse/i.test(text), `expected a parse failure, got: ${text}`);
});

test('check_tool_compatibility distinguishes API-driven from CLI-driven', async () => {
  const tc = await callText('check_tool_compatibility', { tool: 'Testcontainers' });
  assert.match(tc.text, /socket|Engine API|not work|incompatible/i);

  const dc = await callText('check_tool_compatibility', { tool: 'VS Code Dev Containers' });
  assert.match(dc.text, /dockerPath/);
  assert.match(dc.text, /wslc/);
});

test('check_tool_compatibility handles unknown tools without crashing', async () => {
  const { text } = await callText('check_tool_compatibility', { tool: 'SomeUnknownTool' });
  assert.ok(text.length > 0);
});

test('check_devcontainer flags compose and features, allows forwardPorts', async () => {
  const { text } = await callText('check_devcontainer', {
    content: '{"name":"a","dockerComposeFile":"x.yml","features":{},"forwardPorts":[3000]}',
  });
  assert.match(text, /dockerComposeFile/);
  assert.match(text, /features/);
  assert.ok(!/forwardPorts.*not supported/i.test(text));
});

test('get_wslc_limitations covers the documented gaps', async () => {
  const { text } = await callText('get_wslc_limitations', {});
  for (const topic of [/Compose/i, /restart/i, /socket|Engine API/i, /GPU|CDI/i, /platform/i]) {
    assert.match(text, topic);
  }
});

test('unknown tool returns an error and the server stays alive', async () => {
  const bad = await callText('nope', {});
  assert.equal(bad.isError, true);
  const still = await callText('convert_docker_command', { command: 'docker images' });
  assert.match(still.text, /wslc image list/);
});
