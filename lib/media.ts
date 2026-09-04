import { rm, unlink } from "node:fs/promises";
import path from "node:path";

// 制品落盘媒体以 outputId 命名。删除制品/笔记本/用户时一并清理,避免磁盘孤儿文件。
// 路径与 lib/audio.ts、video.ts、infographic.ts、aippt.ts 的 *_DIR 保持一致;
// 此处直接拼路径(不 import 那些模块)以避免 db ↔ media ↔ audio 的循环依赖。
const DATA = path.join(process.cwd(), ".data");
const mediaFiles = (id: string) => [
  path.join(DATA, "audio", `${id}.mp3`),
  path.join(DATA, "video", `${id}.mp4`),
  path.join(DATA, "infographic", `${id}.png`),
  path.join(DATA, "aippt", `${id}.pptx`),
];

/** Best-effort 删除某制品的全部落盘媒体(文件不存在则静默忽略)。 */
export async function deleteOutputMedia(id: string): Promise<void> {
  await Promise.all([
    ...mediaFiles(id).map((f) => unlink(f).catch(() => {})),
    rm(path.join(DATA, "aippt", id), { recursive: true, force: true }).catch(() => {}),
    rm(path.join(DATA, "cad", id), { recursive: true, force: true }).catch(() => {}),
  ]);
}
