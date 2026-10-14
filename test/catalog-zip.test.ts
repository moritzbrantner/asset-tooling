// Unit tests for the archive-member zip reader (#118) beyond the acceptance
// suite: general-purpose flags 3 and 11, which real provider zips may use.
import test from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { extractZipMember, listZipEntries } from "../src/catalog-zip.js";

function zipOne({ name, data, method = 8, flags = 0, localZeroed = false, descriptor = false }) {
  const nameBytes = Buffer.from(name, "utf8");
  const payload = method === 8 ? deflateRawSync(data) : Buffer.from(data);
  const crc = crc32(data) >>> 0;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(flags, 6);
  lh.writeUInt16LE(method, 8);
  lh.writeUInt32LE(localZeroed ? 0 : crc, 14);
  lh.writeUInt32LE(localZeroed ? 0 : payload.byteLength, 18);
  lh.writeUInt32LE(localZeroed ? 0 : data.byteLength, 22);
  lh.writeUInt16LE(nameBytes.byteLength, 26);
  const parts = [lh, nameBytes, payload];
  if (descriptor) {
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(payload.byteLength, 8);
    dd.writeUInt32LE(data.byteLength, 12);
    parts.push(dd);
  }
  const local = Buffer.concat(parts);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(flags, 8);
  ch.writeUInt16LE(method, 10);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(payload.byteLength, 20);
  ch.writeUInt32LE(data.byteLength, 24);
  ch.writeUInt16LE(nameBytes.byteLength, 28);
  ch.writeUInt32LE(0x20, 38);
  const central = Buffer.concat([ch, nameBytes]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(local.byteLength, 16);
  return Buffer.concat([local, central, end]);
}

const DATA = Buffer.from("member payload ".repeat(20));

test("zip reader accepts the UTF-8 name flag (bit 11) and matches names byte-for-byte", () => {
  const name = "Pack/Café Door.gltf";
  const archive = zipOne({ name, data: DATA, flags: 0x0800 });
  assert.deepEqual(extractZipMember(archive, name), DATA);
  assert.throws(() => extractZipMember(archive, "Pack/Café Door.gltf"), /not present/);
  assert.equal(listZipEntries(archive)[0].name, name);
});

test("zip reader accepts a data descriptor (bit 3) with zeroed local sizes, using the central directory", () => {
  const archive = zipOne({ name: "Door.gltf", data: DATA, flags: 0x0008, localZeroed: true, descriptor: true });
  assert.deepEqual(extractZipMember(archive, "Door.gltf"), DATA);
});

test("zip reader rejects any other general-purpose flag with the entry name", () => {
  for (const flags of [0x0002, 0x0004, 0x0040, 0x2000]) {
    assert.throws(() => extractZipMember(zipOne({ name: "Door.gltf", data: DATA, flags }), "Door.gltf"), /'Door\.gltf'.*flags/);
  }
});
