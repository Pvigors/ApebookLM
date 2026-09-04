import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AdminPasswordLogin from "@/components/AdminPasswordLogin";
import { adminPasswordAccount } from "@/lib/admin-password-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "系统管理员登录 · 猿笔记",
  robots: { index: false, follow: false, noarchive: true, nocache: true },
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!adminPasswordAccount()) notFound();
  const query = await searchParams;
  const nextPath = query.next === "/" ? "/" : "/admin";
  return <AdminPasswordLogin nextPath={nextPath} />;
}
