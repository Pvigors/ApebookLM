import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ExperienceLogin from "@/components/ExperienceLogin";
import { experienceAccountByAccessKey } from "@/lib/experience-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "测试账号登录 · 猿笔记",
  robots: { index: false, follow: false, noarchive: true, nocache: true },
};

export default async function ExperiencePage({
  params,
}: {
  params: Promise<{ accessKey: string }>;
}) {
  const { accessKey } = await params;
  if (!experienceAccountByAccessKey(accessKey)) notFound();
  return <ExperienceLogin accessKey={accessKey} />;
}
