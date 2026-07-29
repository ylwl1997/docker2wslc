import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyse } from '../src/compose.js';
import { translate } from '../src/translate.js';

const CASES = [
  ['docker run -it ubuntu:24.04 bash', 'wslc run -it ubuntu:24.04 bash'],
  ['docker ps', 'wslc container list'],
  ['docker ps -a', 'wslc container list --all'],
  ['docker ps -aq', 'wslc container list -aq'],
  ['docker images', 'wslc image list'],
  ['docker rmi -f abc123', 'wslc image remove --force abc123'],
  ['docker rm -f web', 'wslc container remove --force web'],
  ['docker build -t app:1 .', 'wslc build -t app:1 .'],
  ['docker pull nginx:alpine', 'wslc pull nginx:alpine'],
  ['docker exec -it web sh', 'wslc exec -it web sh'],
  ['docker logs -f web', 'wslc logs -f web'],
  ['sudo docker ps', 'wslc container list'],
  ['podman run alpine', 'wslc run alpine'],
  ['docker create --name x alpine', 'wslc container create --name x alpine'],
  ['docker cp web:/etc/hosts ./hosts', 'wslc container cp web:/etc/hosts ./hosts'],
  ['docker container prune', 'wslc container prune'],
];

// Subcommands that exist in neither form on wslc 2.9.4.0. `wslc image history`
// is NOT a valid target -- the image noun has no history or search verb.
const NO_EQUIVALENT = ['history', 'search', 'restart', 'pause', 'unpause', 'top', 'wait', 'port', 'rename', 'diff', 'commit', 'info'];
for (const verb of NO_EQUIVALENT) {
  test(`${verb} has no wslc equivalent`, () => {
    const r = translate(`docker ${verb} nginx`);
    assert.ok(r.output.startsWith('#'), `expected a comment, got: ${r.output}`);
    assert.ok(!/^wslc /.test(r.output));
    assert.equal(r.exitCode, 2);
  });
}

test('system prune has no equivalent; per-noun prunes do', () => {
  const r = translate('docker system prune -a');
  assert.ok(r.output.startsWith('#'), `expected a comment, got: ${r.output}`);
  assert.equal(r.exitCode, 2);
  for (const noun of ['container', 'image', 'volume', 'network']) {
    assert.equal(translate(`docker ${noun} prune`).output, `wslc ${noun} prune`);
  }
});

for (const [src, expected] of CASES) {
  test(`maps: ${src}`, () => {
    assert.equal(translate(src).output, expected);
  });
}

test('platform dropped, exit 1', () => {
  const r = translate('docker build --platform linux/amd64 -t app .');
  assert.equal(r.output, 'wslc build -t app .');
  assert.equal(r.exitCode, 1);
});

test('platform inline dropped', () => {
  assert.equal(translate('docker build --platform=linux/arm64 .').output, 'wslc build .');
});

// wslc 2.9.4.0 has --gpus natively and has NO --device. Rewriting to --device
// turns a working command into one that fails with "Argument name was not
// recognized". Verified by execution on a Windows Server 2025 runner.
test('gpus is kept verbatim, never rewritten to --device', () => {
  const r = translate('docker run --gpus all nvidia/cuda:12.4.0-base');
  assert.equal(r.output, 'wslc run --gpus all nvidia/cuda:12.4.0-base');
  assert.ok(!r.output.includes('--device'));
});

test('--device is dropped, because wslc has no such flag', () => {
  const r = translate('docker run --device /dev/snd alpine');
  assert.ok(!r.output.includes('--device'));
  assert.equal(r.exitCode, 1);
});

// wslc rejects `512m` with `Invalid memory argument value`; Docker accepts both
// cases, so a copied command silently breaks. Fix it, don't just warn.
const SIZE_FIXES = [
  ['docker run -m 512m alpine', 'wslc run -m 512M alpine'],
  ['docker run --memory=1g alpine', 'wslc run --memory=1G alpine'],
  ['docker run --shm-size 64m alpine', 'wslc run --shm-size 64M alpine'],
  ['docker run -m 512mb alpine', 'wslc run -m 512MB alpine'],
];
for (const [src, expected] of SIZE_FIXES) {
  test(`rewrites size unit: ${src}`, () => {
    const r = translate(src);
    assert.equal(r.output, expected);
    assert.equal(r.exitCode, 1);
  });
}

test('already-uppercase size is untouched and clean', () => {
  const r = translate('docker run -m 2G alpine');
  assert.equal(r.output, 'wslc run -m 2G alpine');
  assert.equal(r.exitCode, 0);
});

test('unparseable size is still an error', () => {
  assert.equal(translate('docker run -m bogus alpine').exitCode, 2);
});

// Flags Docker has that `wslc run` does not implement: passing them through
// would produce "Argument name was not recognized" at runtime.
const ABSENT_FLAGS = [
  ['--cap-add', 'docker run --cap-add NET_ADMIN alpine'],
  ['--cap-drop', 'docker run --cap-drop ALL alpine'],
  ['--privileged', 'docker run --privileged alpine'],
  ['--security-opt', 'docker run --security-opt seccomp=unconfined alpine'],
  ['--expose', 'docker run --expose 8080 nginx'],
  ['--device', 'docker run --device /dev/snd alpine'],
];
for (const [flag, src] of ABSENT_FLAGS) {
  test(`drops ${flag}, which wslc does not have`, () => {
    const r = translate(src);
    assert.ok(!r.output.includes(flag), `${flag} must not survive into the output`);
    assert.equal(r.exitCode, 1);
  });
}

// Flags that DO exist on wslc run and must survive untouched.
const PRESENT_FLAGS = [
  'docker run --gpus all nvidia/cuda:12.4-base',
  "docker run --health-cmd 'pg_isready -U postgres' postgres:16",
  'docker run --no-healthcheck redis',
  'docker run -P nginx',
  'docker run --ulimit nofile=1024:2048 alpine',
  'docker run --stop-signal SIGINT alpine',
  'docker run --dns 1.1.1.1 alpine',
  'docker run --network none alpine',
  'docker run --tmpfs /tmp alpine',
];
for (const src of PRESENT_FLAGS) {
  const flag = src.split(' ').find((t) => t.startsWith('-'));
  test(`keeps ${flag}, which wslc supports`, () => {
    const r = translate(src);
    assert.ok(r.output.includes(flag), `${flag} exists on wslc and must be kept`);
    assert.ok(r.exitCode === 0 || r.exitCode === 1);
  });
}

test('restart dropped is degraded', () => {
  const r = translate('docker run --restart always -d redis');
  assert.ok(!r.output.includes('--restart'));
  assert.equal(r.exitCode, 1);
});

// wslc refuses host networking loudly (exit 1, "host mode networking is not
// supported") rather than ignoring it. The flag is kept in the output so the
// reader sees what they wrote, and the note is severity=error.
test('network host is reported as an error, not silently dropped', () => {
  const r = translate('docker run --network host alpine');
  assert.equal(r.exitCode, 2);
  assert.ok(r.notes.some((n) => n.severity === 'error' && /host mode networking is not supported/.test(n.text)));
});

test('custom network kept', () => {
  assert.ok(translate('docker run --network mynet alpine').output.includes('--network mynet'));
});

test('compose is unmigratable', () => {
  const r = translate('docker compose up -d');
  assert.equal(r.composeHit, true);
  assert.equal(r.exitCode, 2);
});

test('swarm unsupported', () => {
  const r = translate('docker swarm init');
  assert.equal(r.unsupportedHit, true);
  assert.equal(r.exitCode, 2);
});

test('buildx unsupported', () => {
  assert.equal(translate('docker buildx build .').exitCode, 2);
});

test('windows path note', () => {
  const r = translate('docker run -v C:/work:/app -it ubuntu bash');
  assert.ok(r.output.includes('-v C:/work:/app'));
  assert.ok(r.notes.some((n) => n.text.includes('VirtioFS')));
});

test('quoted args preserved', () => {
  assert.ok(translate('docker run alpine sh -c "echo hello world"').output.includes('"echo hello world"'));
});

test('comments and blanks preserved', () => {
  const r = translate('# setup\ndocker ps\n\ndocker images');
  assert.equal(r.output.split('\n')[0], '# setup');
  assert.ok(r.output.includes('wslc container list'));
});

test('non-docker line untouched', () => {
  assert.ok(translate('ls -la').output.startsWith('# not a docker command'));
});

test('clean command exit 0', () => {
  assert.equal(translate('docker run alpine').exitCode, 0);
});

test('unknown verb degraded', () => {
  const r = translate('docker frobnicate x');
  assert.equal(r.exitCode, 1);
  assert.equal(r.output, 'wslc frobnicate x');
});

test('notes deduplicated', () => {
  const r = translate('docker build --platform linux/amd64 .\ndocker run --platform linux/amd64 alpine');
  assert.equal(r.notes.filter((n) => n.text.includes('--platform')).length, 1);
});

const COMPOSE = `
services:
  web:
    image: nginx:alpine
    ports: ["8080:80"]
    environment:
      - NGINX_HOST=localhost
    depends_on: [db]
    restart: always
  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      retries: 5
    cap_add: [NET_ADMIN]
    mem_limit: 512m
volumes:
  pgdata:
`;

test('compose analysis', () => {
  const rep = analyse(COMPOSE);
  assert.equal(rep.parseError, null);
  assert.deepEqual(rep.services.map((s) => s.name), ['web', 'db']);

  const web = rep.services[0];
  assert.ok(web.command.includes('wslc run -d --name web'));
  assert.ok(web.command.includes('-p 8080:80'));
  assert.ok(web.command.includes('-e NGINX_HOST=localhost'));
  assert.ok(web.missing.some((m) => m.key === 'depends_on'));
  assert.ok(web.missing.some((m) => m.key === 'restart'));

  // healthcheck IS supported: wslc run has --health-cmd and friends, so the
  // block is translated into flags rather than reported as missing.
  const db = rep.services[1];
  assert.ok(!db.missing.some((m) => m.key === 'healthcheck'));
  assert.ok(db.ok.includes('healthcheck'));
  assert.match(db.command, /--health-cmd 'pg_isready -U postgres'/);
  assert.match(db.command, /--health-interval 10s/);
  assert.match(db.command, /--health-retries 5/);
  // mem_limit: 512m must be uppercased or wslc rejects it.
  assert.match(db.command, /-m 512M/);
  assert.ok(db.missing.some((m) => m.key === 'cap_add'));
  // Flags wslc does not have must never appear in generated compose commands.
  for (const absent of ['--cap-add', '--device', '--privileged', '--security-opt', '--expose']) {
    assert.ok(!db.command.includes(absent), `${absent} must not be emitted`);
  }
  assert.ok(rep.prelude.includes('wslc volume create pgdata'));
  assert.equal(rep.exitCode, 2);
});

test('compose bad yaml', () => {
  const rep = analyse('services: [oops');
  assert.ok(rep.parseError);
  assert.equal(rep.exitCode, 2);
});
