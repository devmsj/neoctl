// Browser + Node >=20 native Web Crypto; no Node-only imports.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const directions = new Set(['up', 'down']);
export function decodeBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid base64');
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (encodeBase64(bytes) !== value) throw new Error('Invalid base64');
  return bytes;
}
export function encodeBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function aad(deviceId, direction) {
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId) || !directions.has(direction)) throw new Error('Invalid context');
  return encoder.encode(JSON.stringify([deviceId, direction]));
}
async function importKey(keyBase64, usage) {
  const bytes = decodeBase64(keyBase64);
  if (bytes.byteLength !== 32) throw new Error('Key must be 32 bytes');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [usage]);
}
export async function seal(keyBase64, deviceId, direction, payload) {
  const additionalData = aad(deviceId, direction);
  const key = await importKey(keyBase64, 'encrypt');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = JSON.stringify(payload);
  if (plaintext === undefined) throw new Error('Payload must be JSON');
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, key, encoder.encode(plaintext));
  return { v: 1, nonce: encodeBase64(nonce), ciphertext: encodeBase64(new Uint8Array(encrypted)) };
}
export async function open(keyBase64, deviceId, direction, envelope) {
  const additionalData = aad(deviceId, direction);
  if (!envelope || envelope.v !== 1) throw new Error('Invalid envelope');
  const nonce = decodeBase64(envelope.nonce);
  const ciphertext = decodeBase64(envelope.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 16) throw new Error('Invalid envelope');
  const key = await importKey(keyBase64, 'decrypt');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, key, ciphertext);
  return JSON.parse(decoder.decode(plaintext));
}
