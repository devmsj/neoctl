import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { findAvailablePort, helpText, parseArgs } from './bin/neow.mjs';

test('neow exposes useful help', () => {
  const help = helpText();
  assert.match(help, /neow/);
  assert.match(help, /--runtime-port/);
  assert.match(help, /--no-open/);
});

test('neow parses ports and host', () => {
  assert.deepEqual(parseArgs(['--host', '0.0.0.0', '-p', '5200', '--runtime-port', '3200', '--no-open']), {
    host: '0.0.0.0', port: 5200, runtimeHost: '127.0.0.1', runtimePort: 3200, open: false,
  });
  assert.throws(() => parseArgs(['--port', '0']), /1-65535/);
  assert.throws(() => parseArgs(['--wat']), /未知参数/);
});

test('neow skips occupied ports', async () => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  const selected = await findAvailablePort(address.port, '127.0.0.1');
  assert.ok(selected > address.port);
  await new Promise((resolve) => occupied.close(resolve));
});
