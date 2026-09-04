/** PPT/PPTX 来源统一硬上限：与套餐的其它文件额度无关。 */
export const PPTX_MAX_FILE_BYTES = 25 * 1024 * 1024;

export function isPptxFileName(name: string): boolean {
  return /\.pptx$/i.test(name.trim());
}

/** 某个文件真正生效的上传上限：PPTX 永远不超过 25MB。 */
export function uploadLimitForFile(name: string, planLimitBytes: number): number {
  return isPptxFileName(name)
    ? Math.min(planLimitBytes, PPTX_MAX_FILE_BYTES)
    : planLimitBytes;
}

