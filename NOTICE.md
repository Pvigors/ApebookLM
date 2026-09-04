# 第三方软件声明

ApebookLM 社区版自身代码适用仓库根目录的 GNU AGPL v3。第三方组件仍适用其各自许可证；本声明不改变、限制或替代任何第三方许可条款。

完整、可复现的依赖名称、精确版本、下载地址与完整性哈希记录在 `package-lock.json`。正式发行物还必须随附源码、Web 镜像和 CAD 镜像的 SBOM 与第三方许可证归档；缺少这些材料的构建不得标记为正式发行版。

## 直接运行时依赖

- MIT：`@excalidraw/excalidraw`、`@excalidraw/mermaid-to-excalidraw`、`@lexical/*`、`@types/katex`、`@types/pg`、`@xmldom/xmldom`、`@xyflow/react`、`fflate`、`html-to-image`、`html2canvas`、`jspdf`、`katex`、`lexical`、`mind-elixir`、`next`、`pg`、`react`、`react-dom`、`react-markdown`、`remark-gfm`、`replicad`、`reveal.js`、`server-only`、`three`、`unpdf`、`x-data-spreadsheet`。
- Apache-2.0：`@huggingface/transformers`、`@mozilla/readability`、`openai`、`sharp`、`xlsx`。
- LGPL-3.0-or-later：Sharp 随平台安装的 `@img/sharp-libvips-*` 运行时二进制；发行镜像需保留相应许可与上游源码入口。
- ISC：`linkedom`。
- BSD-2-Clause：`mammoth`。
- MIT OR GPL-3.0-or-later：`jszip`（本项目按 MIT 选项使用）。
- LGPL-2.1-only：`replicad-opencascadejs`（Open CASCADE/WASM 运行内核）。完整 LGPL-2.1 文本随该包分发；上游项目源码与构建入口可从 <https://github.com/sgenoud/replicad> 获取。
- LGPL-2.1-or-later：Debian `libfreecad-python3-0.20 0.20.2+dfsg1-4`（仅独立 CAD worker 容器内的原生 STEP 二次复读库）。本项目不修改、嵌入 UI 或重品牌化 FreeCAD；按 Debian 包原样分发，用户可替换该独立组件。上游源码与许可说明：<https://github.com/FreeCAD/FreeCAD> 与 <https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/License.md>。Debian 精确包版本的 copyright 文件随容器保留在 `/usr/share/doc/libfreecad-python3-0.20/`。
- Debian eSpeak NG 包族：Web 运行容器安装 `espeak-ng`、`espeak-ng-data` 与
  `libespeak-ng1`，仅通过独立命令提供离线系统语音。Debian copyright 元数据把主要
  上游源码标为 GPL-3.0-or-later，同时记录 Apple、NetBSD/BSD 等文件级独立条款，因而
  不把包内每个文件笼统声明为 GPL。镜像保留 `/usr/share/doc/espeak-ng*/copyright`、
  `/usr/share/doc/libespeak-ng1/copyright` 与 `/usr/share/common-licenses/GPL-3`；生成的
  SBOM 对该包族保留 `NOASSERTION` 的结论并指向这些完整通知。上游源码与许可见
  <https://github.com/espeak-ng/espeak-ng>。

`x-data-spreadsheet@1.1.9` 的 MIT 许可保持不变。本项目安装时仅对其编辑器文本渲染做确定性安全补丁，把 `innerHTML` 写入改为 Text node；补丁脚本为 `scripts/patch-x-data-spreadsheet.mjs`。

`@excalidraw/excalidraw@0.18.1` 的 MIT 许可保持不变。为避免其字体子集 Worker 在 Webpack/Next 构建中固化为构建机 `file://` 地址，安装脚本将该可选 Worker 固定为上游已有的主线程降级路径；补丁不改变画板数据格式与导出结果。

`components/editor-nodes/table/` 中的表格操作交互改编自 Meta Lexical Playground，继续适用 Lexical 的 MIT 许可并保留文件头中的上游版权说明。

## 可选智能工作流与 sidecar

- MIT：`@langchain/core@1.2.9`、`@langchain/langgraph@1.4.13`、`zod@3.25.76` 及其 MIT 传递依赖。LangGraph.js 仅用于服务端测验阶段编排；不启用 LangSmith tracing，也不运行 Agent Server。
- MIT：Docling Serve `v1.31.0`（独立文档解析 sidecar；模型权重与模型卡另行适用）。
- Apache-2.0：Crawl4AI `v0.9.2`（独立网页正文 sidecar）。
- MIT core：LiteLLM `v1.98.0`（独立模型网关）；其 `enterprise/` 目录及企业功能不在本项目使用范围内，仍适用上游商业许可。

这些 sidecar 不复制进猿笔记主代码，也不改变主仓库许可证；正式发布时必须保存固定镜像 digest、SBOM、上游 LICENSE/NOTICE 与模型卡。

## Text2CAD 名称边界

本项目只实现自研的“Text2CAD 兼容受控命令序列”产品链路。未复制、下载或分发 SadilKhan/DFKI Text2CAD 仓库代码、训练数据或模型权重；相关论文/项目只作为架构思想参考。若将来引入其代码、数据或权重，必须重新完成商业许可与 NOTICE 审查。

若发现遗漏或许可标注与上游包不一致，以随依赖包分发的原始许可文本为准，并请在发布前修正本声明。
