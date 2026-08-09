/**
 * Hand-written Protobuf encoder/decoder + Connect-RPC frame handling.
 *
 * Matches the Windsurf wire format exactly.
 * Python bytearray → Node.js Buffer
 * struct.pack(">I", len) → buf.writeUInt32BE
 * gzip.compress/decompress → zlib.gzipSync/gunzipSync
 */

import { gzipSync, gunzipSync } from "node:zlib";

// ─── Protobuf Encoder ──────────────────────────────────────

export class ProtobufEncoder {
  constructor() {
    /** @type {Buffer[]} */
    this._chunks = [];
  }

  /**
   * Encode an unsigned varint into a Buffer.
   * @param {number} value
   * @returns {Buffer}
   */
  _varint(value) {
    const bytes = [];
    while (value > 0x7f) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return Buffer.from(bytes);
  }

  /**
   * Encode a field tag.
   * @param {number} field
   * @param {number} wire
   * @returns {Buffer}
   */
  _tag(field, wire) {
    return this._varint((field << 3) | wire);
  }

  /**
   * Write a varint field.
   * @param {number} field
   * @param {number} value
   * @returns {ProtobufEncoder}
   */
  writeVarint(field, value) {
    this._chunks.push(this._tag(field, 0), this._varint(value));
    return this;
  }

  /**
   * Write a length-delimited string field.
   * @param {number} field
   * @param {string} value
   * @returns {ProtobufEncoder}
   */
  writeString(field, value) {
    const data = Buffer.from(value, "utf-8");
    this._chunks.push(this._tag(field, 2), this._varint(data.length), data);
    return this;
  }

  /**
   * Write a length-delimited bytes field.
   * @param {number} field
   * @param {Buffer|Uint8Array} value
   * @returns {ProtobufEncoder}
   */
  writeBytes(field, value) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this._chunks.push(this._tag(field, 2), this._varint(buf.length), buf);
    return this;
  }

  /**
   * Write a nested message field.
   * @param {number} field
   * @param {ProtobufEncoder} sub
   * @returns {ProtobufEncoder}
   */
  writeMessage(field, sub) {
    const data = sub.toBuffer();
    this._chunks.push(this._tag(field, 2), this._varint(data.length), data);
    return this;
  }

  /**
   * Return the encoded bytes as a Buffer.
   * @returns {Buffer}
   */
  toBuffer() {
    return Buffer.concat(this._chunks);
  }
}

// ─── Varint Decode ─────────────────────────────────────────

/**
 * Decode a varint from a buffer at the given offset.
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {[number, number]} [value, newOffset]
 */
export function decodeVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [value, offset];
}

// ─── Protobuf String Extraction ────────────────────────────

/**
 * Extract all UTF-8 strings (length > 5) from raw protobuf data
 * by parsing wire types. Matches Python proto_extract_strings().
 * @param {Buffer} data
 * @returns {string[]}
 */
export function extractStrings(data) {
  const strings = [];
  let i = 0;
  while (i < data.length) {
    // Read tag varint
    let tag = 0;
    let shift = 0;
    while (i < data.length) {
      const b = data[i++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const wire = tag & 0x7;
    if (wire === 0) {
      // Varint — skip
      while (i < data.length) {
        const b = data[i++];
        if (!(b & 0x80)) break;
      }
    } else if (wire === 1) {
      // 64-bit fixed
      i += 8;
    } else if (wire === 2) {
      // Length-delimited
      let length = 0;
      shift = 0;
      while (i < data.length) {
        const b = data[i++];
        length |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      if (i + length <= data.length) {
        const raw = data.subarray(i, i + length);
        try {
          const text = raw.toString("utf-8");
          if (text.length > 5) {
            strings.push(text);
          }
        } catch {
          // Not valid UTF-8, skip
        }
      }
      i += length;
    } else if (wire === 5) {
      // 32-bit fixed
      i += 4;
    } else {
      // Unknown wire type — stop
      break;
    }
  }
  return strings;
}

// ─── Connect-RPC Frame Encode/Decode ───────────────────────

/**
 * Encode protobuf bytes into a gzip-compressed Connect-RPC frame.
 * Frame format: 1-byte flags + 4-byte big-endian length + payload
 * @param {Buffer} protoBytes
 * @param {boolean} [compress=true]
 * @returns {Buffer}
 */
export function connectFrameEncode(protoBytes, compress = true) {
  let payload;
  let flags;
  if (compress) {
    payload = gzipSync(protoBytes);
    flags = 1; // gzip compressed
  } else {
    payload = protoBytes;
    flags = 0;
  }
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Decode Connect-RPC frames from raw response data.
 * Handles gzip-compressed frames (flags 1 or 3).
 * @param {Buffer} data
 * @returns {Buffer[]}
 */
export function connectFrameDecode(data) {
  const frames = [];
  let i = 0;
  while (i + 5 <= data.length) {
    const flags = data[i];
    const length = data.readUInt32BE(i + 1);
    i += 5;
    let payload = data.subarray(i, i + length);
    i += length;
    if (flags === 1 || flags === 3) {
      try {
        payload = gunzipSync(payload);
      } catch {
        // Decompression failed — use raw payload
      }
    }
    frames.push(Buffer.from(payload));
  }
  return frames;
}
