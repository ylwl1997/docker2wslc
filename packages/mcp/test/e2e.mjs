/** Drive the MCP server over real stdio JSON-RPC and print every response. */
import { spawn } from 'node:child_process';

const proc = spawn('node', ['src/server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const seen = new Map();

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
    } catch { /* partial */ }
  }
});
proc.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

const send = (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`);
const wait = async (id, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (seen.has(id)) return seen.get(id);
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout waiting for id=${id}`);
};

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
});
const init = await wait(1);
console.log('INIT server:', JSON.stringify(init.result.serverInfo));

send({ jsonrpc: '2.0', method: 'notifications/initialized' });

send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const list = await wait(2);
console.log('TOOLS:', list.result.tools.map((t) => t.name).join(', '));

const CALLS = [
  ['convert_docker_command', { command: 'docker run --gpus all --restart always -p 80:80 nginx' }],
  ['convert_docker_command', { command: 'docker compose up -d' }],
  ['check_tool_compatibility', { tool: 'Testcontainers' }],
  ['check_tool_compatibility', { tool: 'VS Code Dev Containers' }],
  ['check_devcontainer', { content: '{"name":"a","dockerComposeFile":"x.yml","features":{},"forwardPorts":[3000]}' }],
  ['analyze_compose', { content: 'services:\n  web:\n    image: nginx\n    restart: always\n    depends_on: [db]\n  db:\n    image: postgres:16\n' }],
  ['get_wslc_limitations', {}],
  ['convert_docker_command', { command: '' }],
  ['check_tool_compatibility', { tool: 'SomeUnknownTool' }],
];

let id = 10;
for (const [name, args] of CALLS) {
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const res = await wait(id);
  const text = res.result?.content?.[0]?.text ?? JSON.stringify(res);
  const err = res.result?.isError ? ' [isError]' : '';
  console.log(`\n===== ${name}(${JSON.stringify(args).slice(0, 60)})${err} =====`);
  console.log(text.split('\n').slice(0, 12).join('\n'));
  id += 1;
}

// unknown tool must not crash the server
send({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'nope', arguments: {} } });
const bad = await wait(99);
console.log('\nUNKNOWN TOOL ->', bad.result?.content?.[0]?.text, '| isError:', bad.result?.isError);

proc.kill();
console.log('\nALL MCP CALLS COMPLETED');
