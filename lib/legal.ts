// 法律文档解析:后台可在 app_settings(键 legal.<slug>)存覆盖版;无覆盖则回落到内置文案。
import { getSetting, setSetting, deleteSetting } from "./db";
import { AGREEMENT, PRIVACY, type LegalDoc } from "./legal-content";

const DEFAULTS: Record<string, LegalDoc> = { agreement: AGREEMENT, privacy: PRIVACY };

export type LegalSlug = "agreement" | "privacy";

/** 前台/后台读取生效版本:有后台覆盖用覆盖,否则内置默认。slug/kicker 始终以默认为准。 */
export async function getLegalDoc(slug: LegalSlug): Promise<LegalDoc> {
  const def = DEFAULTS[slug];
  const raw = await getSetting(`legal.${slug}`);
  if (!raw) return def;
  try {
    const ov = JSON.parse(raw) as Partial<LegalDoc>;
    return { ...def, ...ov, slug: def.slug, kicker: def.kicker };
  } catch {
    return def;
  }
}

export function getDefaultLegalDoc(slug: LegalSlug): LegalDoc {
  return DEFAULTS[slug];
}

export async function isLegalOverridden(slug: LegalSlug): Promise<boolean> {
  return (await getSetting(`legal.${slug}`)) != null;
}

export async function setLegalDoc(slug: LegalSlug, doc: Partial<LegalDoc>, adminId: string): Promise<void> {
  // 仅存可编辑字段,避免把默认整块写死。
  const { title, updated, effective, intro, principle, sections } = doc;
  await setSetting(`legal.${slug}`, JSON.stringify({ title, updated, effective, intro, principle, sections }), adminId);
}

export async function resetLegalDoc(slug: LegalSlug): Promise<void> {
  await deleteSetting(`legal.${slug}`);
}
