import { redirect } from "next/navigation";
import { userFromCookies } from "@/lib/auth";
import { isWeChatLoginEnabled } from "@/lib/wechat-login";
import { isSmsLoginEnabled } from "@/lib/sms";
import { adminPasswordAccount } from "@/lib/admin-password-access";
import { isLocalPreviewAutoLoginEnabled } from "@/lib/local-preview-auth";
import LoginClient from "@/components/LoginClient";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await userFromCookies()) redirect("/");
  // 微信入口是否露出由服务端判定:密钥在 server-only 模块里,客户端组件读不到。
  return (
    <LoginClient
      wechatLive={isWeChatLoginEnabled()}
      phoneLive={isSmsLoginEnabled()}
      adminLive={Boolean(adminPasswordAccount())}
      previewLive={isLocalPreviewAutoLoginEnabled()}
    />
  );
}
