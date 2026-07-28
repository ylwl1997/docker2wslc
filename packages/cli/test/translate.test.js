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
  ['docker history nginx', 'wslc image history nginx'],
  ['docker create --name x alpine', 'wslc container create --name x alpine'],
];

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

test('gpus rewritten to CDI', () => {
  const r = translate('docker run --gpus all nvidia/cuda:12.4.0-base');
  assert.equal(r.output, 'wslc run --device nvidia.com/gpu=all nvidia/cuda:12.4.0-base');
});

test('restart dropped is degraded', () => {
  const r = translate('docker run --restart always -d redis');
  assert.ok(!r.output.includes('--restart'));
  assert.equal(r.exitCode, 1);
});

test('network host dropped', () => {
  assert.equal(translate('docker run --network host alpine').output, 'wslc run alpine');
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
      test: ["CMD", "pg_isready"]
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

  assert.ok(rep.services[1].missing.some((m) => m.key === 'healthcheck'));
  assert.ok(rep.prelude.includes('wslc volume create pgdata'));
  assert.equal(rep.exitCode, 2);
});

test('compose bad yaml', () => {
  const rep = analyse('services: [oops');
  assert.ok(rep.parseError);
  assert.equal(rep.exitCode, 2);
});
