/**
 * Pure JavaScript FIPS 46-3 Single DES (ECB + PKCS7) for MV3 Service Workers.
 * Implements WebCC's password encryption algorithm:
 *   key = UTF8(username.slice(-4) + username + "12345678")[0..7]
 *   ciphertext = hex(DES_ECB_PKCS7(UTF8(password), key))
 */

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2,
  60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6,
  64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1,
  59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5,
  63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32,
  39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30,
  37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28,
  35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26,
  33, 1, 41, 9, 49, 17, 57, 25,
];

const E = [
  32, 1, 2, 3, 4, 5,
  4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13,
  12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21,
  20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29,
  28, 29, 30, 31, 32, 1,
];

const P = [
  16, 7, 20, 21,
  29, 12, 28, 17,
  1, 15, 23, 26,
  5, 18, 31, 10,
  2, 8, 24, 14,
  32, 27, 3, 9,
  19, 13, 30, 6,
  22, 11, 4, 25,
];

const PC1 = [
  57, 49, 41, 33, 25, 17, 9,
  1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27,
  19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15,
  7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29,
  21, 13, 5, 28, 20, 12, 4,
];

const PC2 = [
  14, 17, 11, 24, 1, 5,
  3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8,
  16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55,
  30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53,
  46, 42, 50, 36, 29, 32,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const SBOX = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

const textEncoder = new TextEncoder();

function permuteBits(inputBits, table) {
  const out = new Uint8Array(table.length);
  for (let i = 0; i < table.length; i++) {
    out[i] = inputBits[table[i] - 1];
  }
  return out;
}

function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    for (let j = 0; j < 8; j++) {
      bits[i * 8 + j] = (b >>> (7 - j)) & 1;
    }
  }
  return bits;
}

function bitsToBytes(bits) {
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i++) {
    let val = 0;
    for (let j = 0; j < 8; j++) {
      val = (val << 1) | bits[i * 8 + j];
    }
    bytes[i] = val;
  }
  return bytes;
}

function rotateLeft28(half, shift) {
  const out = new Uint8Array(28);
  for (let i = 0; i < 28; i++) {
    out[i] = half[(i + shift) % 28];
  }
  return out;
}

function generateSubkeys(keyBytes8) {
  if (!(keyBytes8 instanceof Uint8Array) || keyBytes8.length < 8) {
    throw new Error('DES key must be at least 8 bytes');
  }
  const keyBits = bytesToBits(keyBytes8.subarray(0, 8));
  const permuted = permuteBits(keyBits, PC1);
  let left = permuted.subarray(0, 28);
  let right = permuted.subarray(28, 56);

  const subkeys = [];
  for (let round = 0; round < 16; round++) {
    left = rotateLeft28(left, SHIFTS[round]);
    right = rotateLeft28(right, SHIFTS[round]);
    const combined = new Uint8Array(56);
    combined.set(left, 0);
    combined.set(right, 28);
    subkeys.push(permuteBits(combined, PC2));
  }
  return subkeys;
}

function feistel(right32, subkey48) {
  const expanded = permuteBits(right32, E);
  const sOut = new Uint8Array(32);

  for (let box = 0; box < 8; box++) {
    const off = box * 6;
    const b0 = expanded[off] ^ subkey48[off];
    const b1 = expanded[off + 1] ^ subkey48[off + 1];
    const b2 = expanded[off + 2] ^ subkey48[off + 2];
    const b3 = expanded[off + 3] ^ subkey48[off + 3];
    const b4 = expanded[off + 4] ^ subkey48[off + 4];
    const b5 = expanded[off + 5] ^ subkey48[off + 5];

    const row = (b0 << 1) | b5;
    const col = (b1 << 3) | (b2 << 2) | (b3 << 1) | b4;
    const val = SBOX[box][row * 16 + col];

    const outOff = box * 4;
    sOut[outOff] = (val >>> 3) & 1;
    sOut[outOff + 1] = (val >>> 2) & 1;
    sOut[outOff + 2] = (val >>> 1) & 1;
    sOut[outOff + 3] = val & 1;
  }

  return permuteBits(sOut, P);
}

/**
 * Encrypt a single 8-byte block with precomputed DES subkeys.
 */
export function desEncryptBlock(block8, subkeys) {
  const bits = bytesToBits(block8);
  const ip = permuteBits(bits, IP);
  let left = ip.subarray(0, 32);
  let right = ip.subarray(32, 64);

  for (let round = 0; round < 16; round++) {
    const f = feistel(right, subkeys[round]);
    const nextRight = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      nextRight[i] = left[i] ^ f[i];
    }
    left = right;
    right = nextRight;
  }

  const preOutput = new Uint8Array(64);
  preOutput.set(right, 0);
  preOutput.set(left, 32);
  return bitsToBytes(permuteBits(preOutput, FP));
}

function pkcs7Pad(bytes) {
  const padLen = 8 - (bytes.length % 8);
  const padded = new Uint8Array(bytes.length + padLen);
  padded.set(bytes, 0);
  padded.fill(padLen, bytes.length);
  return padded;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Encrypt UTF-8 plaintext using DES-ECB with PKCS7 padding and return lowercase hex.
 */
export function encryptDesEcbPkcs7Hex(plaintext, keyBytes8) {
  const subkeys = generateSubkeys(keyBytes8);
  const rawBytes = textEncoder.encode(plaintext);
  const padded = pkcs7Pad(rawBytes);
  const out = new Uint8Array(padded.length);

  for (let offset = 0; offset < padded.length; offset += 8) {
    const encrypted = desEncryptBlock(padded.subarray(offset, offset + 8), subkeys);
    out.set(encrypted, offset);
  }

  return bytesToHex(out);
}

/**
 * Derive the 8-byte DES key used by WebCC from the login username.
 */
export function deriveWebCCKeyBytes(username) {
  const str = String(username || '');
  const keySource = str.slice(-4) + str + '12345678';
  return textEncoder.encode(keySource).subarray(0, 8);
}

/**
 * Encrypt a WebCC login password for the given login username.
 */
export function encryptWebCCPassword(username, password) {
  const keyBytes = deriveWebCCKeyBytes(username);
  return encryptDesEcbPkcs7Hex(String(password ?? ''), keyBytes);
}
