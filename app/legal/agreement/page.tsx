import LegalArticle from "@/components/LegalArticle";
import { getLegalDoc } from "@/lib/legal";

export const dynamic = "force-dynamic";
export const metadata = { title: "用户协议 · 猿笔记" };

export default async function AgreementPage() {
  return <LegalArticle doc={await getLegalDoc("agreement")} />;
}
