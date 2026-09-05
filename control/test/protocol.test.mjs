import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal, open } from '../protocol.mjs';

const directions = ['up', 'down'];
const deviceId = 'test-device_protocol-01';
const makeKey = () => randomBytes(32).toString('base64');
const makePayload = () => ({
  text: '你好，世界！🔐 café e\u0301 日本語 العربية\n第二行',
  nested: {
    values: [null, true, false, 0, -12.5, '', { message: '嵌套消息🚀' }],
    emptyObject: {},
    emptyArray: [],
  },
});

function flipByte(base64, index = 0) {
  const bytes = Buffer.from(base64, 'base64');
  assert.ok(bytes.length > 0, 'The field being tampered with must be nonempty');
  const offset = index < 0 ? bytes.length + index : index;
  assert.ok(offset >= 0 && offset < bytes.length);
  bytes[offset] ^= 1;
  return bytes.toString('base64');
}

for (const direction of directions) {
  test(`${direction}: Unicode and nested payload round trip`, async () => {
    const key = makeKey();
    const payload = makePayload();
    const envelope = await seal(key, deviceId, direction, payload);

    assert.equal(envelope.v, 1);
    assert.equal(typeof envelope.nonce, 'string');
    assert.ok(Buffer.from(envelope.nonce, 'base64').length > 0);
    assert.equal(typeof envelope.ciphertext, 'string');
    assert.ok(Buffer.from(envelope.ciphertext, 'base64').length > 0);
    assert.deepEqual(await open(key, deviceId, direction, envelope), payload);
  });

  test(`${direction}: repeated sealing uses distinct nonces`, async () => {
    const key = makeKey();
    const payload = makePayload();
    const envelopes = await Promise.all(
      Array.from({ length: 8 }, () => seal(key, deviceId, direction, payload)),
    );
    const nonces = envelopes.map(({ nonce }) => {
      assert.equal(typeof nonce, 'string');
      const bytes = Buffer.from(nonce, 'base64');
      assert.ok(bytes.length > 0);
      return bytes.toString('hex');
    });
    assert.equal(new Set(nonces).size, envelopes.length);
    for (const envelope of envelopes) {
      assert.deepEqual(await open(key, deviceId, direction, envelope), payload);
    }
  });

  test(`${direction}: ciphertext does not contain plaintext`, async () => {
    const key = makeKey();
    const marker = 'PRIVATE-PLAINTEXT-MARKER-DO-NOT-EXPOSE-0123456789';
    const payload = { marker, unicode: '不应出现在密文中的完整明文消息🔐🚀' };
    const envelope = await seal(key, deviceId, direction, payload);
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    for (const plaintext of [marker, payload.unicode, JSON.stringify(payload)]) {
      assert.equal(envelope.ciphertext.includes(plaintext), false);
      assert.equal(ciphertext.includes(Buffer.from(plaintext, 'utf8')), false);
    }
    assert.deepEqual(await open(key, deviceId, direction, envelope), payload);
  });

  test(`${direction}: ciphertext, GCM tag and nonce tampering reject`, async (t) => {
    const key = makeKey();
    const payload = makePayload();
    const envelope = await seal(key, deviceId, direction, payload);
    await t.test('every ciphertext/tag byte', async () => {
      // Cover both encrypted data and tag without assuming the tag's offset or size.
      const length = Buffer.from(envelope.ciphertext, 'base64').length;
      for (let index = 0; index < length; index += 1) {
        const tampered = { ...envelope, ciphertext: flipByte(envelope.ciphertext, index) };
        await assert.rejects(
          async () => open(key, deviceId, direction, tampered),
          `Tampering with ciphertext/tag byte ${index} must reject`,
        );
      }
    });
    await t.test('nonce', async () => {
      const tampered = { ...envelope, nonce: flipByte(envelope.nonce) };
      await assert.rejects(async () => open(key, deviceId, direction, tampered));
    });
    assert.deepEqual(await open(key, deviceId, direction, envelope), payload);
  });

  test(`${direction}: wrong key, deviceId and direction reject`, async (t) => {
    const key = makeKey();
    const envelope = await seal(key, deviceId, direction, makePayload());
    const wrongKey = makeKey();
    assert.notEqual(wrongKey, key);
    const otherDirection = directions.find((value) => value !== direction);
    const cases = [
      ['key', wrongKey, deviceId, direction],
      ['deviceId', key, `${deviceId}-other`, direction],
      ['direction', key, deviceId, otherDirection],
    ];
    for (const [name, candidateKey, candidateDevice, candidateDirection] of cases) {
      await t.test(name, async () => {
        await assert.rejects(async () =>
          open(candidateKey, candidateDevice, candidateDirection, envelope),
        );
      });
    }
  });

  test(`${direction}: unsupported or invalid version rejects`, async (t) => {
    const key = makeKey();
    const envelope = await seal(key, deviceId, direction, makePayload());
    for (const version of [0, 2, -1, '1', null, false]) {
      await t.test(`v=${JSON.stringify(version)}`, async () => {
        await assert.rejects(async () =>
          open(key, deviceId, direction, { ...envelope, v: version }),
        );
      });
    }
    const { v: ignored, ...withoutVersion } = envelope;
    await t.test('missing v', async () => {
      await assert.rejects(async () => open(key, deviceId, direction, withoutVersion));
    });
  });

  test(`${direction}: malformed envelopes reject`, async (t) => {
    const key = makeKey();
    const envelope = await seal(key, deviceId, direction, makePayload());
    const { nonce: ignoredNonce, ...withoutNonce } = envelope;
    const { ciphertext: ignoredCiphertext, ...withoutCiphertext } = envelope;
    const cases = [
      ['undefined', undefined],
      ['null', null],
      ['string', 'not-an-envelope'],
      ['number', 1],
      ['boolean', true],
      ['array', []],
      ['empty object', {}],
      ['missing nonce', withoutNonce],
      ['missing ciphertext', withoutCiphertext],
    ];
    for (const field of ['nonce', 'ciphertext']) {
      for (const [name, value] of [
        ['null', null],
        ['number', 123],
        ['object', {}],
        ['array', []],
        ['empty', ''],
        ['invalid base64', '!!!%%%***'],
      ]) {
        cases.push([`${field}: ${name}`, { ...envelope, [field]: value }]);
      }
    }
    cases.push([
      'truncated ciphertext/tag',
      { ...envelope, ciphertext: Buffer.from(envelope.ciphertext, 'base64').subarray(0, 1).toString('base64') },
    ]);
    for (const [name, malformed] of cases) {
      await t.test(name, async () => {
        await assert.rejects(async () => open(key, deviceId, direction, malformed));
      });
    }
  });
}
