/**
 * Headless test of the extension's diagnostic logic using a minimal `vscode` stub.
 * Verifies real ranges and messages without launching an Extension Host.
 */
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

// ---- minimal vscode stub -------------------------------------------------
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  translate(dl, dc) { return new Position(this.line + (dl || 0), this.character + (dc || 0)); }
}
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; }
    else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
class Diagnostic {
  constructor(range, message, severity) {
    this.range = range; this.message = message; this.severity = severity;
  }
}
const stored = new Map();
const vscodeStub = {
  Position, Range, Diagnostic,
  DiagnosticSeverity: { Warning: 1, Information: 2 },
  Uri: { parse: (s) => ({ toString: () => s, scheme: 'https' }) },
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri, diags) => stored.set(uri.fsPath, diags),
      delete: (uri) => stored.delete(uri.fsPath),
      dispose() {},
    }),
  },
  workspace: {
    textDocuments: [],
    workspaceFolders: [],
    getConfiguration: () => ({ update: async () => {} }),
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
  },
  window: { showInformationMessage() {}, showQuickPick: async () => null, showInputBox: async () => '' },
  commands: { registerCommand: () => ({ dispose() {} }) },
  env: { clipboard: { writeText: async () => {} } },
  ConfigurationTarget: { Workspace: 2, Global: 1 },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.call(this, request, ...rest);
};

const ext = require(path.join(__dirname, '..', 'src', 'extension.js'));

// ---- fake TextDocument --------------------------------------------------
function makeDoc(fsPath, text) {
  const lines = text.split('\n');
  return {
    uri: { scheme: 'file', fsPath },
    getText: () => text,
    lineCount: lines.length,
    lineAt: (i) => ({ text: lines[i] }),
    positionAt: (offset) => {
      let remaining = offset;
      for (let i = 0; i < lines.length; i += 1) {
        if (remaining <= lines[i].length) return new Position(i, remaining);
        remaining -= lines[i].length + 1;
      }
      return new Position(lines.length - 1, 0);
    },
  };
}

const COMPOSE = `services:
  web:
    image: nginx:alpine
    ports: ["8080:80"]
    restart: always
    depends_on: [db]
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD", "pg_isready"]
    volumes:
      - pgdata:/var/lib/postgresql/data
`;

const DEVCONTAINER = `{
  // uses compose
  "name": "app",
  "dockerComposeFile": "docker-compose.yml",
  "features": {},
  "forwardPorts": [3000],
  "remoteUser": "node"
}
`;

test('activate registers without throwing', () => {
  ext.activate({ subscriptions: [] });
});

test('compose diagnostics flag unsupported keys', () => {
  ext.activate({ subscriptions: [] });
  const doc = makeDoc('/proj/docker-compose.yml', COMPOSE);
  // refresh is internal; drive it through the open handler surface
  const diags = runRefresh(doc);
  const keys = diags.map((d) => d.message.split(':')[0]);
  assert.ok(keys.includes('restart'), `expected restart, got ${keys}`);
  assert.ok(keys.includes('depends_on'));
  assert.ok(keys.includes('healthcheck'));
  assert.ok(keys.includes('volumes'));
  assert.ok(!keys.includes('image'));
  assert.ok(!keys.includes('ports'));

  const restart = diags.find((d) => d.message.startsWith('restart'));
  assert.equal(restart.severity, 1, 'missing keys should be Warning');
  const line = COMPOSE.split('\n')[restart.range.start.line];
  assert.ok(line.includes('restart'), `range points at wrong line: ${line}`);

  const volumes = diags.find((d) => d.message.startsWith('volumes'));
  assert.equal(volumes.severity, 2, 'partial keys should be Information');
});

test('devcontainer diagnostics flag compose and features', () => {
  const diags = runRefresh(makeDoc('/proj/.devcontainer/devcontainer.json', DEVCONTAINER));
  const keys = diags.map((d) => d.message.split(':')[0]);
  assert.ok(keys.includes('dockerComposeFile'));
  assert.ok(keys.includes('features'));
  assert.ok(!keys.includes('forwardPorts'));
  assert.ok(!keys.includes('remoteUser'));

  const dcf = diags.find((d) => d.message.startsWith('dockerComposeFile'));
  const line = DEVCONTAINER.split('\n')[dcf.range.start.line];
  assert.ok(line.includes('dockerComposeFile'), `bad range: ${line}`);
});

test('clean compose yields no diagnostics', () => {
  const clean = 'services:\n  app:\n    image: alpine\n    ports: ["80:80"]\n';
  assert.equal(runRefresh(makeDoc('/proj/compose.yml', clean)).length, 0);
});

test('unrelated files are ignored', () => {
  assert.equal(runRefresh(makeDoc('/proj/README.md', '# hi')), undefined);
});

test('malformed yaml does not throw', () => {
  assert.deepEqual(runRefresh(makeDoc('/proj/docker-compose.yml', 'services: [broken')), []);
});

test('malformed json does not throw', () => {
  assert.deepEqual(runRefresh(makeDoc('/proj/devcontainer.json', '{broken')), []);
});

// Drive the module's refresh by re-invoking activate handlers is awkward;
// instead call the exported activate once and use the collection contents.
function runRefresh(doc) {
  stored.clear();
  // onDidOpenTextDocument handler is registered inside activate; emulate by
  // calling the same code path through a fresh activate + textDocuments scan.
  vscodeStub.workspace.textDocuments = [doc];
  ext.activate({ subscriptions: [] });
  return stored.get(doc.uri.fsPath);
}
