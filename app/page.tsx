import HomeClient from "@/components/HomeClient";
import LandingClient from "@/components/LandingClient";
import { isWeChatLoginEnabled } from "@/lib/wechat-login";
import { isSmsLoginEnabled } from "@/lib/sms";
import AnnouncementBanner from "@/components/AnnouncementBanner";
import { adminUserFromCookies, userFromCookies } from "@/lib/auth";
import { adminRoleOf } from "@/lib/admin";
import { adminPasswordAccount, isAdminPasswordLoginEnforced } from "@/lib/admin-password-access";
import { getAppConfig } from "@/lib/app-config";
import { listNotebooks } from "@/lib/db";
import { isLocalPreviewAutoLoginEnabled } from "@/lib/local-preview-auth";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await userFromCookies();
  // 未登录看官网、已登录进工作台。以前这里直接 302 去 /login,访客连产品是什么都看不到,
  // 微信开放平台审核也抓不到可读的站点内容。
  if (!user) {
    return (
      <LandingClient
        wechatLive={isWeChatLoginEnabled()}
        phoneLive={isSmsLoginEnabled()}
        adminLive={Boolean(adminPasswordAccount())}
        previewLive={isLocalPreviewAutoLoginEnabled()}
      />
    );
  }
  const cfg = await getAppConfig();
  const adminRole = adminRoleOf(user);
  const announcement = cfg.announcement;
  // 服务端直出笔记本列表:进首页即见,免客户端二次 fetch + 骨架屏闪烁。
  const initialNotebooks = await listNotebooks(user.id);
  // 仅有应用设置写权限的 operator / 已完成独立验证的 super 可看下架制品用于验收；
  // auditor 保持只读，开启独立登录后普通短信 super 也不能借前台绕过管理会话。
  const verifiedSuper = adminRole === "super" && (
    !isAdminPasswordLoginEnforced() || (await adminUserFromCookies())?.id === user.id
  );
  const hiddenForUser = adminRole === "operator" || verifiedSuper
    ? []
    : [...new Set([...cfg.hidden_artifacts, ...(!cfg.cad_enabled ? ["cad"] : [])])];
  // 用户自定义隐藏的磁贴(个人偏好,与后台下架相互独立):SSR 直出免闪烁。
  const userHiddenTiles = (user.hidden_tiles ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return (
    <>
      {announcement.trim() && <AnnouncementBanner text={announcement} />}
      <HomeClient
        user={{
          id: user.id,
          name: user.name,
          avatar: user.avatar,
          phone: user.phone,
          email: user.email,
          plan_tier: user.plan_tier,
          adminRole,
        }}
        initialNotebooks={initialNotebooks}
        hiddenArtifacts={hiddenForUser}
        userHiddenTiles={userHiddenTiles}
      />
    </>
  );
}
