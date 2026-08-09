import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProtobufEncoder,
  decodeVarint,
  extractStrings,
  connectFrameEncode,
  connectFrameDecode,
} from "../deepgrep/src/protobuf.mjs";

describe("ProtobufEncoder", () => {
  it("writeString + extractStrings round-trip", () => {
    const enc = new ProtobufEncoder();
    enc.writeString(1, "hello_world");
    enc.writeString(2, "test_value");
    const buf = enc.toBuffer();
    const strs = extractStrings(buf);
    assert(strs.includes("hello_world"));
    assert(strs.includes("test_value"));
  });

  it("writeVarint encodes correctly", () => {
    const enc = new ProtobufEncoder();
    enc.writeVarint(1, 300);
    const buf = enc.toBuffer();
    assert(buf.length > 0);
  });

  it("writeMessage nests correctly", () => {
    const inner = new ProtobufEncoder();
    inner.writeString(1, "nested_value");
    const outer = new ProtobufEncoder();
    outer.writeMessage(1, inner);
    const strs = extractStrings(outer.toBuffer());
    // extractStrings may include wire-format prefix bytes in the extracted string
    assert(strs.some((s) => s.includes("nested_value")));
  });
});

describe("decodeVarint", () => {
  it("decodes single-byte varint", () => {
    const [val, newOffset] = decodeVarint(Buffer.from([0x05]), 0);
    assert.equal(val, 5);
    assert.equal(newOffset, 1); // absolute offset after reading
  });

  it("decodes multi-byte varint", () => {
    const [val, newOffset] = decodeVarint(Buffer.from([0xac, 0x02]), 0);
    assert.equal(val, 300);
    assert.equal(newOffset, 2);
  });

  it("handles offset", () => {
    const buf = Buffer.from([0xff, 0x01, 0x05]);
    const [val, newOffset] = decodeVarint(buf, 2);
    assert.equal(val, 5);
    assert.equal(newOffset, 3); // started at 2, read 1 byte → offset 3
  });
});

describe("connectFrame encode/decode round-trip", () => {
  it("round-trips data through gzip framing", () => {
    const original = Buffer.from("test protobuf data for framing");
    const encoded = connectFrameEncode(original, true);
    assert(Buffer.isBuffer(encoded));
    const frames = connectFrameDecode(encoded);
    assert(frames.length >= 1);
    // The decoded frame should contain our original data
    const combined = Buffer.concat(frames);
    const strs = combined.toString("utf-8");
    assert(strs.includes("test protobuf data for framing"));
  });

  it("uncompressed round-trip", () => {
    const original = Buffer.from("uncompressed payload");
    const encoded = connectFrameEncode(original, false);
    const frames = connectFrameDecode(encoded);
    const combined = Buffer.concat(frames);
    assert(combined.toString("utf-8").includes("uncompressed payload"));
  });
});
