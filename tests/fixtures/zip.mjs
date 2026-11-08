function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipFixture(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, content, mode = 0o100644] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(content), crc = crc32(data);
    const header = Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
    local.push(header,filename,data);
    const record = Buffer.alloc(46);record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(0x0314,4);record.writeUInt16LE(20,6);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(filename.length,28);record.writeUInt32LE((mode*65536)>>>0,38);record.writeUInt32LE(offset,42);
    central.push(record,filename);offset+=header.length+filename.length+data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
