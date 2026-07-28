/**
 * wslc Compatibility — VS Code diagnostics for Compose / devcontainer files.
 * Flags keys that will not work with the native WSL container runtime.
 * https://wslcontainers.com
 */

const vscode = require('vscode');
const { parseDocument, isMap } = require('yaml');
const RULES = require('../rules.json');

const SOURCE = 'wslc';
const COMPOSE_RE = /(docker-)?compose\.ya?ml$/i;
const DEVCONTAINER_RE = /devcontainer\.json$/i;

let collection;

function severityFor(status) {
  return status === 'missing'
    ? vscode.DiagnosticSeverity.Warning
    : vscode.DiagnosticSeverity.Information;
}

/** Range covering a key token on the line it appears, else the whole line. */
function keyRange(doc, offset, key) {
  if (offset !== null && offset !== undefined) {
    const start = doc.positionAt(offset);
    return new vscode.Range(start, start.translate(0, key.length));
  }
  for (let i = 0; i < doc.lineCount; i += 1) {
    const text = doc.lineAt(i).text;
    const idx = text.indexOf(key);
    if (idx > -1) return new vscode.Range(i, idx, i, idx + key.length);
  }
  return new vscode.Range(0, 0, 0, 1);
}

function makeDiagnostic(range, key, spec, docsUrl) {
  const label = spec.status === 'missing' ? 'not supported by wslc' : 'behaves differently in wslc';
  const d = new vscode.Diagnostic(
    range,
    `${key}: ${label}. ${spec.note || ''}`.trim(),
    severityFor(spec.status),
  );
  d.source = SOURCE;
  d.code = { value: `wslc/${key}`, target: vscode.Uri.parse(docsUrl) };
  return d;
}

function lintCompose(doc) {
  const out = [];
  let parsed;
  try {
    parsed = parseDocument(doc.getText());
  } catch {
    return out;
  }
  const services = parsed.get('services');
  if (!isMap(services)) return out;

  for (const svcItem of services.items) {
    const body = svcItem.value;
    if (!isMap(body)) continue;
    for (const entry of body.items) {
      const key = String(entry.key?.value ?? '');
      const spec = RULES.compose.keys[key];
      if (!spec || spec.status === 'ok') continue;
      const offset = entry.key?.range?.[0] ?? null;
      out.push(makeDiagnostic(keyRange(doc, offset, key), key, spec, RULES.links.compose));
    }
  }
  return out;
}

function lintDevcontainer(doc) {
  const out = [];
  const text = doc.getText();
  let parsed;
  try {
    // devcontainer.json is JSONC; strip // comments before parsing.
    parsed = JSON.parse(
      text.split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n'),
    );
  } catch {
    return out;
  }
  for (const key of Object.keys(parsed)) {
    const spec = RULES.devcontainer.keys[key];
    if (!spec || spec.status === 'ok') continue;
    const idx = text.indexOf(`"${key}"`);
    const range = idx > -1
      ? new vscode.Range(doc.positionAt(idx + 1), doc.positionAt(idx + 1 + key.length))
      : new vscode.Range(0, 0, 0, 1);
    out.push(makeDiagnostic(range, key, spec, RULES.links.devcontainers));
  }
  return out;
}

function refresh(doc) {
  if (!doc || doc.uri.scheme !== 'file') return;
  const path = doc.uri.fsPath;
  let diagnostics = [];
  if (COMPOSE_RE.test(path)) diagnostics = lintCompose(doc);
  else if (DEVCONTAINER_RE.test(path)) diagnostics = lintDevcontainer(doc);
  else return;
  collection.set(doc.uri, diagnostics);
}

/** Translate the selected docker command (or current line) to wslc. */
async function explainCommand() {
  const editor = vscode.window.activeTextEditor;
  const { translate } = await import('./translate.mjs');

  let input = '';
  if (editor) {
    const sel = editor.selection;
    input = sel.isEmpty ? editor.document.lineAt(sel.active.line).text : editor.document.getText(sel);
  }
  if (!input.trim()) {
    input = (await vscode.window.showInputBox({
      prompt: 'Docker command to translate to wslc',
      placeHolder: 'docker run --gpus all -p 80:80 nginx',
    })) || '';
  }
  if (!input.trim()) return;

  const result = translate(input);
  const pick = await vscode.window.showQuickPick(
    [
      { label: result.output, description: 'copy to clipboard' },
      ...result.notes.map((n) => ({ label: `${n.severity}: ${n.text}`, description: '' })),
    ],
    { title: 'wslc equivalent' },
  );
  if (pick && pick.description === 'copy to clipboard') {
    await vscode.env.clipboard.writeText(result.output);
    vscode.window.showInformationMessage('wslc command copied.');
  }
}

/** Offer to set dev.containers.dockerPath to wslc. */
async function useWslcForDevContainers() {
  const config = vscode.workspace.getConfiguration('dev.containers');
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await config.update('dockerPath', 'wslc', target);
  const scope = target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'user';
  vscode.window.showInformationMessage(
    `dev.containers.dockerPath set to "wslc" (${scope}). Reopen in Container to use it.`,
  );
}

function activate(context) {
  collection = vscode.languages.createDiagnosticCollection(SOURCE);
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document)),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
    vscode.commands.registerCommand('wslc.explainCommand', explainCommand),
    vscode.commands.registerCommand('wslc.useForDevContainers', useWslcForDevContainers),
  );
  vscode.workspace.textDocuments.forEach(refresh);
}

function deactivate() {
  if (collection) collection.dispose();
}

module.exports = { activate, deactivate };
