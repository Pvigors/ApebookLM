# ApebookLM 社区版开发约定

本仓库是 ApebookLM 的可自托管社区版。变更应保持核心链路可运行：来源导入、带引用问答、笔记、智能制品、公开分享与管理员配置。

## 技术基线

- Next.js 15、React 19、TypeScript strict、Tailwind CSS。
- PostgreSQL 是唯一业务数据库；时间戳使用 Unix 毫秒。
- 外部模型统一走 OpenAI 兼容接口；个人 API Key 只在服务端加密保存。
- 后台权限以 `lib/admin.ts` 的模块矩阵和服务端鉴权为准。
- CAD 生成运行在独立 worker，并保留 STEP 独立复读验证。

## 开发规则

1. 用户界面使用简体中文；产品文案使用“智能生成”，不在普通界面暴露实现术语。
2. 所有用户可控 URL 抓取必须经过 `ssrfSafeFetch`。
3. 新增数据库列同时更新 `db/schema.pg.sql` 和 `lib/db.ts` 的兼容迁移。
4. 跨进程互斥、幂等和队列认领必须依赖数据库状态，不能只用进程内变量。
5. 密钥、真实账号、用户资料、生产拓扑和本地生成物不得提交。
6. 社区版不包含商业运营模块；积分仅作为实例内部的资源用量单位。
7. 修改第三方改编代码时保留上游版权、许可证和来源说明。

## 验证

提交前至少执行：

```bash
npx tsc --noEmit --incremental false
npm test
npm run check:public
npm run build
```

测试需要 PostgreSQL 16，并通过 `PG_ADMIN_URL` 提供具有 `CREATEDB` 权限的测试账号。不要让测试连接开发库或生产库。

## 提交范围

- 一个逻辑变更一个提交，提交说明使用简体中文。
- 不提交 `.env*`、`.data/`、`.next*`、评测报告、临时原型或调试截图。
- 新功能同步更新 README、配置示例、测试和必要的第三方声明。
