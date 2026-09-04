// PNG 归属追溯:往生成的 PNG(信息图 / 小红书 / 思维导图 / 画板导出)里注入 iTXt 文本块。
// 原来这些 PNG 是裸位图(零 tEXt/iTXt/EXIF),抱走后无痕、不可举证。iTXt 用 UTF-8,
// 能装中文版权说明(tEXt 只能 Latin-1)。看图工具的「属性/元数据」即可见到猿笔记指纹。
// 失败安全:非法/非 PNG 输入一律原样返回,绝不破坏产物。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个 iTXt chunk:len(4) + "iTXt"(4) + data + crc(4);data 布局见 PNG 规范 11.3.4.5。 */
function itxtChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0x00]), // keyword 结束
    Buffer.from([0x00]), // compression flag = 0(未压缩)
    Buffer.from([0x00]), // compression method = 0
    Buffer.from([0x00]), // language tag(空)结束
    Buffer.from([0x00]), // translated keyword(空)结束
    Buffer.from(text, "utf8"),
  ]);
  const typed = Buffer.concat([Buffer.from("iTXt", "latin1"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

const PNG_SIG = 0x89504e47;

/** 往 PNG 的 IHDR 之后插入品牌追溯 iTXt(合法位置:辅助块可在 IHDR 与 IDAT 之间)。 */
export function stampPngProvenance(png: Buffer): Buffer {
  // IHDR 恒为首块:签名(8)+ len(4)=13 + "IHDR"(4)+ data(13)+ crc(4) = 结束于偏移 33。
  const ihdrEnd = 33;
  if (png.length < ihdrEnd + 12 || png.readUInt32BE(0) !== PNG_SIG) return png;
  if (png.toString("latin1", 12, 16) !== "IHDR") return png;
  const marks = [
    itxtChunk("Copyright", "© 猿笔记 ApebookLM"),
    itxtChunk("Comment", "本内容由猿笔记(apebooklm)智能生成,受版权保护,禁止未授权二次分发"),
    itxtChunk("Software", "apebooklm"),
  ];
  return Buffer.concat([png.subarray(0, ihdrEnd), ...marks, png.subarray(ihdrEnd)]);
}
