# 静态资产说明

## 产品品牌资产

`app/icon.png`、`app/apple-icon.png` 与 `public/brand/` 下的 Logo 和品牌图版权归 ApebookLM Contributors 所有，并按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可复制、修改与分发。该版权许可不授予商标权；名称和标识的使用边界另见 `TRADEMARKS.md`。

## 项目界面截图

`public/help/*.png` 和 `docs/images/*.png` 是使用本项目组件和模拟数据生成的文档截图，不包含真实用户资料。它们随本项目文档按 GNU AGPL v3 分发。

`docs/images/social-preview.png` 由 `scripts/build-social-cover.mjs` 将项目 Logo、已有 UI 截图与宣传文字组合生成。60 秒产品介绍视频与可编辑源文件作为 Release 推广附件提供，采用同样的文档许可；源文件不包含系统字体。

## 第三方内容

仓库不应包含未登记来源的照片、插画、模型权重、字体或数据集。新增二进制资产时，Pull Request 必须说明作者、来源、生成方式、许可证及是否包含第三方商标或个人信息。

正式发行前应使用 `assets-manifest.json` 核对每个已跟踪二进制资产的 SHA-256。
