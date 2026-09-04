// 客户端图片水印:把一张图片 Blob 叠加对角平铺「猿笔记」后返回新 PNG Blob。
// 用于「导出即水印」的客户端图片制品(思维导图 PNG 导出、画板导出图)——
// 基础权益在导出前调用，免水印权益不调用。纯浏览器 API，不在服务端运行。
// 出错一律回退原 Blob,绝不因水印失败而毁掉用户的导出。


export async function stampImageWatermark(
  blob: Blob,
  opts?: { text?: string; color?: string; opacity?: number }
): Promise<Blob> {
  try {
    const text = opts?.text ?? "猿笔记";
    const img = await createImageBitmap(blob);
    const w = img.width;
    const h = img.height;
    if (!w || !h) return blob;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(img, 0, 0);
    ctx.save();
    ctx.globalAlpha = opts?.opacity ?? 0.13;
    ctx.fillStyle = opts?.color ?? "#8a8a8a";
    const fs = Math.max(20, Math.round(Math.min(w, h) / 22));
    ctx.font = `800 ${fs}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.translate(w / 2, h / 2);
    ctx.rotate((-26 * Math.PI) / 180);
    // 铺满整幅(以对角线为半径),奇偶行错位,平铺更均匀。
    const stepX = fs * 6.5;
    const stepY = fs * 4.5;
    const R = Math.hypot(w, h) / 2 + Math.max(stepX, stepY);
    let row = 0;
    for (let y = -R; y < R; y += stepY, row++) {
      const off = row % 2 ? stepX / 2 : 0;
      for (let x = -R + off; x < R; x += stepX) ctx.fillText(text, x, y);
    }
    ctx.restore();
    return await new Promise<Blob>((resolve) => cv.toBlob((b) => resolve(b || blob), "image/png"));
  } catch {
    return blob;
  }
}
