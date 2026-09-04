# 用户模型 API 配置

## 方案来源

本实现调研了以下开源项目：

- [Vercel AI SDK](https://github.com/vercel/ai)：采用“供应商注册表 + OpenAI-compatible 适配”的运行时思想；本项目已有统一 `lib/openai.ts` 调用层，因此没有为相同能力重复迁移 SDK。
- [LobeHub](https://github.com/lobehub/lobehub)：参考供应商、模型、连接状态三段式配置体验；其现行 Community License 和内部 Store 耦合不适合直接复制。
- [Open WebUI](https://github.com/open-webui/open-webui)：参考固定连接目录与连接测试语义；Svelte/Python 技术栈及品牌许可证不适合嵌入。
- [LibreChat](https://github.com/danny-avila/LibreChat)：参考用户自带密钥（BYOK）语义；不引入整套 Node/Mongo 应用。
- [LiteLLM](https://github.com/BerriAI/litellm)：保留为平台网关与成本治理层，不作为用户设置组件。

结论：使用猿笔记原生 React 界面和现有 OpenAI-compatible 调用层，吸收成熟项目的配置模型，不复制许可证受限或架构耦合的完整页面。

## 用户行为

入口为「设置 → 模型 API 配置」，支持固定目录中的通义千问、OpenAI、OpenRouter、DeepSeek。

1. 选择供应商并填写模型与 API Key。
2. 「仅保存」只保存禁用配置。
3. 「测试并启用」同时测试文本模型与视觉模型；全部成功后才启用。
4. 停用保留密文；删除立即撤销配置。
5. 切换供应商必须重新输入 Key，不会复用上一家密钥。

个人接口仅用于本人拥有、未公开且没有协作者的私有笔记本，以及用户主动发起的联网研究。共享、公开、系统任务和自动来源解析固定使用平台配置。积分、并发、搜索、语音、嵌入与存储限制继续生效。

## 安全与数据路由

- API Key 进入 `user_model_configs` 前使用 AES-256-GCM 加密；AAD 绑定用户、供应商和 revision。
- `MODEL_API_CONFIG_SECRET` 是当前加密主密钥；`MODEL_API_CONFIG_PREVIOUS_SECRET` 只解密旧密文，不参与新加密。
- GET 只返回 `hasKey` 等价状态和末四位提示，不返回密文或明文。
- 首版不接受自定义 Base URL，避免 SSRF、云元数据探测和隐藏指令/来源被发送到用户自控服务。
- 异步任务只冻结 `{mode, providerId, revision}`，不保存 Key 或 URL；执行前再次核对配置版本及笔记本共享状态。
- 个人接口失败后不回退平台或其他用户配置；SDK 重试为 0，任务超时/取消会中止在途个人模型请求。
- 用户调用记入 `byok:<provider>` 通道，`cost_micros=0`，不污染平台供应商成本。
- 配置写入、停用、删除、测试都要求严格同源；测试使用 PostgreSQL 跨实例限流。

## 生产配置

```dotenv
PUBLIC_ORIGIN=https://你的生产域名
MODEL_API_CONFIG_SECRET=<openssl rand -hex 32 的输出>
# 轮换期间可临时保留旧值：
MODEL_API_CONFIG_PREVIOUS_SECRET=
```

生产环境缺少或错误配置当前主密钥时，设置页只读并拒绝保存新密钥，不会回退到旧密钥继续加密。
