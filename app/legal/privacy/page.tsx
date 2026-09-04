import LegalArticle from "@/components/LegalArticle";
import { getLegalDoc } from "@/lib/legal";

export const dynamic = "force-dynamic";
export const metadata = { title: "隐私政策 · 猿笔记" };

export default async function PrivacyPage() {
  return <LegalArticle doc={await getLegalDoc("privacy")} />;
}
