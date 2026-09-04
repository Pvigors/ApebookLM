/** 活动记录的中文标签(纯数据,客户端 / 服务端通用,无副作用)。 */

export const ACTION_CN: Record<string, string> = {
  "auth.login": "登录",
  "auth.logout": "退出登录",
  "auth.signup": "注册",
  "auth.admin_login": "登录管理中心",
  "notebook.create": "创建笔记本",
  "notebook.rename": "重命名笔记本",
  "notebook.public_on": "公开笔记本",
  "notebook.public_off": "取消公开",
  "notebook.delete": "删除笔记本",
  "notebook.copy": "复制笔记本",
  "source.add": "添加来源",
  "source.delete": "删除来源",
  "note.create": "新建笔记",
  "note.delete": "删除笔记",
  "studio.generate": "生成智能笔记",
  "collaborator.add": "添加协作者",
  "collaborator.remove": "移除协作者",
  "discover.search": "发现搜索",
  "admin.retry_job": "重试任务",
  "admin.clear_stuck": "清理卡死任务",
  "admin.purge_logs": "清理调用日志",
  "admin.vacuum": "压缩数据库",
  "admin.backup": "备份数据库",
  "admin.settings_set": "修改后台配置",
  "admin.export_settings": "导出配置",
  "admin.featured_seed": "重建精选样例",
  "admin.user_disable": "停用用户",
  "admin.user_enable": "启用用户",
  "admin.user_delete": "删除用户",
  "admin.user_revoke": "撤销会话",
  "admin.users_reveal_phone": "查看明文手机号",
  "admin.user_set_admin": "授予管理员",
  "admin.user_unset_admin": "取消管理员",
  "admin.user.grant_credits": "赠送积分",
  "admin.user.set_plan": "调整套餐",
  "admin.notify": "发站内通知",
  "admin.notebook_delete": "删除笔记本",
  "admin.notebook_public": "设为公开",
  "admin.notebook_private": "设为私有",
  "admin.notebook_transfer": "转移所有者",
  "admin.notebook_feature": "设为精选",
  "admin.notebook_unfeature": "撤销精选",
  "admin.featured_reorder": "调整精选顺序",
  "admin.featured_meta": "编辑精选信息",
  "admin.source_delete": "删除来源",
  "admin.note_delete": "删除笔记",
  "admin.output_delete": "删除制品",
};

export const TARGET_CN: Record<string, string> = {
  notebook: "笔记本",
  source: "来源",
  note: "笔记",
  output: "制品",
  user: "用户",
  job: "任务",
  setting: "配置",
  session: "会话",
};

export const KIND_CN: Record<string, string> = {
  user: "用户",
  admin: "管理员",
  anon: "匿名",
  system: "系统",
};

export const KIND_TONE: Record<string, "ok" | "warn" | "muted" | "info"> = {
  admin: "info",
  anon: "warn",
  user: "muted",
  system: "muted",
};

export const actionLabel = (a: string) => ACTION_CN[a] ?? a;
