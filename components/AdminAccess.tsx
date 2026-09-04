"use client";

import { createContext, useContext } from "react";

export type AdminAccessValue = {
  role: string;
  name: string;
  modules: string[];
  writableModules: string[];
};

const EMPTY_ACCESS: AdminAccessValue = {
  role: "",
  name: "",
  modules: [],
  writableModules: [],
};

const AdminAccessContext = createContext<AdminAccessValue>(EMPTY_ACCESS);

export function AdminAccessProvider({
  value,
  children,
}: {
  value: AdminAccessValue;
  children: React.ReactNode;
}) {
  return <AdminAccessContext.Provider value={value}>{children}</AdminAccessContext.Provider>;
}

/** 后台页面的权限展示只认 /api/admin/me 下发的真源。
 *  服务端 requireRole 仍是安全边界；这里负责让只读界面不显示不可执行动作。 */
export function useAdminAccess(module?: string) {
  const access = useContext(AdminAccessContext);
  return {
    ...access,
    canAccess: module ? access.modules.includes(module) : false,
    canWrite: module ? access.writableModules.includes(module) : false,
  };
}
