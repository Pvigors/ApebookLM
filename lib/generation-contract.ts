/** 智能生成共用的 Prompt/检索/可判定约束合同。保持纯函数，便于 test/eval 直接验证。 */

export const STUDIO_LANGUAGE_VALUES = ["简体中文", "繁體中文", "English", "日本語"] as const;
export const STUDIO_KIND_VALUES = [
  "study_guide", "briefing", "faq", "timeline", "toc", "blog", "custom", "mindmap",
  "audio", "video", "flashcards", "quiz", "infographic", "slides", "table", "excalidraw",
  "xhs", "drawviso", "cad",
] as const;
export const DRAWING_NODE_COUNT_UNITS = [
  "个节点", "节点", "个方框", "方框", "个框", "框", "nodes", "node", "boxes", "box",
] as const;

export function generationRetrievalQuery(
  instruction: string | null | undefined,
  anchors: string,
  maxInstruction = 800
): string {
  const user = (instruction || "").replace(/\s+/g, " ").trim().slice(0, maxInstruction);
  return [user, anchors.replace(/\s+/g, " ").trim()].filter(Boolean).join(" ");
}

/** 统一的用户单次生成要求：覆盖默认启发式，但绝不覆盖来源忠实性和机器可解析格式。 */
export function studioInstructionClause(instruction: string | null | undefined): string {
  const text = (instruction || "").trim();
  if (!text) return "";
  return `\n\n【本次用户生成要求 · 内容范围最高优先级】\n${text}\n执行规则：这项要求覆盖默认的主题分配、来源覆盖、结构启发式、篇幅和文风选择；但不得突破“只用来源、不编造”和当前制品的固定机器格式。若要求使用“仅/只/聚焦/忽略其他来源”等措辞缩小范围，输出只能包含指定范围，绝对不要提及被排除的来源、主题或术语——即使只是为了说明它们已被排除也不可以。若要求逐字/原样包含某段来源中确实存在的文字，最终用户可见内容必须保留该原文。`;
}

export function isStudioLanguage(value: unknown): value is (typeof STUDIO_LANGUAGE_VALUES)[number] {
  return typeof value === "string" && (STUDIO_LANGUAGE_VALUES as readonly string[]).includes(value);
}

export function isStudioKind(value: unknown): value is (typeof STUDIO_KIND_VALUES)[number] {
  return typeof value === "string" && (STUDIO_KIND_VALUES as readonly string[]).includes(value);
}

/** 从“3页 / 只要一页 / exactly 4 slides”中提取可确定性验收的数量。 */
export function requestedCount(
  instruction: string | null | undefined,
  units: string[]
): number | null {
  const text = (instruction || "").trim();
  if (!text || !units.length) return null;
  const unit = [...new Set(units.map((item) => item.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const prefix = String.raw`(?:只(?:需要|要|需)?|恰好|正好|必须|限定为|控制为|exactly\s*|only\s*)?`;
  const digit = text.match(new RegExp(`${prefix}(\\d{1,2})\\s*(?:${unit})(?![A-Za-z])`, "i"));
  if (digit) return Math.max(1, Number(digit[1]));
  const chineseDigits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9,
  };
  const chineseNumber = (raw: string): number | null => {
    if (raw === "十") return 10;
    if (raw.includes("十")) {
      const [left, right] = raw.split("十");
      const tens = left ? chineseDigits[left] : 1;
      const ones = right ? chineseDigits[right] : 0;
      return tens == null || ones == null ? null : tens * 10 + ones;
    }
    return chineseDigits[raw] ?? null;
  };
  const cn = text.match(new RegExp(`${prefix}([零〇一二两三四五六七八九十]{1,3})\\s*(?:${unit})`));
  if (cn) {
    const value = chineseNumber(cn[1]);
    if (value && value <= 99) return value;
  }
  const englishValues: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const english = text.match(new RegExp(`\\b${prefix}([a-z]+(?:[-\\s][a-z]+)?)\\s+(?:${unit})\\b`, "i"));
  if (english) {
    const words = english[1].toLowerCase().split(/[-\s]+/);
    const values = words.map((word) => englishValues[word]);
    if (values.every((value) => value != null)) {
      const value = values.length === 1 ? values[0] : values[0] + values[1];
      if (value >= 1 && value <= 99) return value;
    }
  }
  return null;
}

/** “必须原样包含『X』”这类要求可以不用模型裁判，直接做确定性门禁。 */
export function requiredVerbatimPhrases(instruction: string | null | undefined): string[] {
  const text = (instruction || "").trim();
  if (!text) return [];
  const phrases = new Set<string>();
  const patterns: RegExp[] = [
    /(?:逐字|原样)(?:包含|保留|出现|写出|提及)?\s*[「『“\"'`]([^」』”\"'`]{1,120})[」』”\"'`]/g,
    /必须(?:包含|保留|出现|写出|提及)\s*[「『“\"'`]([^」』”\"'`]{1,120})[」』”\"'`]/g,
    /(?:必须\s*)?(?:逐字|原样)\s*(?:包含|保留|出现|写出|提及)?\s*(?:为|[:：])?\s*([^\n，,。；;！!？?]{1,120}?)(?=\s*(?:并(?:且)?|同时|然后|但|且|$|[，,。；;！!？?\n]))/gu,
    /必须\s*(?:包含|保留|出现|写出|提及)\s*(?:为|[:：])?\s*([^\n，,。；;！!？?]{1,120}?)(?=\s*(?:并(?:且)?|同时|然后|但|且|$|[，,。；;！!？?\n]))/gu,
    /\bmust\s+(?:include|preserve|retain|mention)\s+(?:verbatim\s+)?(?:the\s+exact\s+(?:phrase|text)\s+)?["'`]?([^\n,.;!?"'`]{1,120}?)["'`]?(?=\s*(?:verbatim\b|and\b|but\b|$|[,.;!?\n]))/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const phrase = match[1]
        .trim()
        .replace(/^[「『“\"'`]+|[」』”\"'`]+$/g, "")
        .trim();
      if (phrase) phrases.add(phrase);
    }
  }
  return [...phrases].filter(Boolean);
}

export type StudioColorRequirement = {
  target: string | null;
  color: string;
  fill: string;
  stroke: string;
};

const COLOR_PALETTES: Record<string, { fill: string; stroke: string }> = {
  red: { fill: "#f8cecc", stroke: "#b85450" },
  blue: { fill: "#dae8fc", stroke: "#6c8ebf" },
  green: { fill: "#d5e8d4", stroke: "#82b366" },
  orange: { fill: "#ffe6cc", stroke: "#d79b00" },
  yellow: { fill: "#fff2cc", stroke: "#d6b656" },
  purple: { fill: "#e1d5e7", stroke: "#9673a6" },
  gray: { fill: "#f5f5f5", stroke: "#666666" },
  black: { fill: "#222222", stroke: "#000000" },
  white: { fill: "#ffffff", stroke: "#999999" },
};

const COLOR_NAMES: Record<string, string> = {
  红色: "red", 红色调: "red", 红: "red", red: "red",
  蓝色: "blue", 蓝色调: "blue", 蓝: "blue", blue: "blue",
  绿色: "green", 绿色调: "green", 绿: "green", green: "green",
  橙色: "orange", 橘色: "orange", 橙: "orange", 橘: "orange", orange: "orange",
  黄色: "yellow", 黄: "yellow", yellow: "yellow",
  紫色: "purple", 紫: "purple", purple: "purple",
  灰色: "gray", 灰: "gray", gray: "gray", grey: "gray",
  黑色: "black", 黑: "black", black: "black",
  白色: "white", 白: "white", white: "white",
};

/** 解析“风险点用红色 / make risks red / 全图 #0f0”这类可确定性视觉要求。 */
export function requestedColorRequirements(
  instruction: string | null | undefined
): StudioColorRequirement[] {
  const text = (instruction || "").trim();
  if (!text) return [];
  const rules: StudioColorRequirement[] = [];
  const globalTarget = /^(?:整体|全局|全图|整个图|全部|所有(?:节点|方框|框)?|[零〇一二两三四五六七八九十\d]{1,3}(?:个)?(?:节点|方框|框)|配色|颜色|主题|背景|overall|global|all(?:\s+(?:nodes|boxes))?|(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:nodes|boxes)|theme|background)$/i;
  const cleanTarget = (raw: string): string | null => {
    const value = raw
      .replace(/^[\s·•*\-—:：把将]+|[\s的]+$/g, "")
      .replace(/\s*(?:必须|务必|应该|应|需要|请|要)$/g, "")
      .replace(/[「」『』“”"'`]/g, "")
      .trim();
    return !value || globalTarget.test(value) ? null : value.slice(-40);
  };
  const add = (targetRaw: string, tokenRaw: string) => {
    const token = tokenRaw.toLowerCase();
    let color = COLOR_NAMES[tokenRaw] || COLOR_NAMES[token] || "";
    let palette: { fill: string; stroke: string } | undefined;
    if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(tokenRaw)) {
      color = tokenRaw.toLowerCase();
      palette = { fill: color, stroke: color };
    } else {
      palette = COLOR_PALETTES[color];
    }
    if (!palette) return;
    const target = cleanTarget(targetRaw);
    const key = `${target ?? "*"}\u0000${palette.fill}\u0000${palette.stroke}`;
    if (rules.some((item) => `${item.target ?? "*"}\u0000${item.fill}\u0000${item.stroke}` === key)) return;
    rules.push({ target, color, ...palette });
  };
  const colorToken = String.raw`(?:红色调|蓝色调|绿色调|红色|蓝色|绿色|橙色|橘色|黄色|紫色|灰色|黑色|白色|红|蓝|绿|橙|橘|黄|紫|灰|黑|白|red|blue|green|orange|yellow|purple|gr[ae]y|black|white|#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)`;
  for (const segment of text.split(/[，,。；;！!？?\n]+/).map((item) => item.trim()).filter(Boolean)) {
    let matched = false;
    const zh = new RegExp(`^(?:请\\s*)?(?:把|将)?\\s*(.*?)\\s*(?:必须|务必|应该|应|需要|请|要)?\\s*(?:用|使用|设为|标为|改为|显示为|着色为|采用|以|标|涂)\\s*(${colorToken})(?:\\s*(?:显示|呈现|标注|标出|标记|突出))?$`, "i").exec(segment);
    if (zh) { add(zh[1], zh[2]); matched = true; }
    const colorFirst = new RegExp(`^(?:请\\s*)?(?:用|使用|采用)?\\s*(${colorToken})\\s*(?:来)?\\s*(?:突出|标出|标记|显示|呈现)?\\s*(.{1,40}?(?:节点|方框|框|模块|部分|node|nodes|box|boxes|module|modules))$`, "i").exec(segment);
    if (colorFirst) { add(colorFirst[2], colorFirst[1]); matched = true; }
    const en = new RegExp(`^(?:make|color|render|mark|highlight)\\s+(.+?)\\s+(?:in\\s+|as\\s+)?(${colorToken})$`, "i").exec(segment);
    if (en) { add(en[1], en[2]); matched = true; }
    if (matched) continue;
    const global = new RegExp(`^(?:(整体|全局|全图|整个图|全部节点|所有节点|配色|颜色|主题|背景|overall|global|all nodes|theme|background)\\s*)?(?:用|使用|采用|设为|改为|is|in)?\\s*(${colorToken})(?:\\s*(?:主题|配色|色调|风格))?$`, "i").exec(segment);
    if (global) { add(global[1] || "", global[2]); continue; }
    const trailing = new RegExp(`^(.{1,40}?)\\s+(${colorToken})$`, "i").exec(segment);
    if (trailing) add(trailing[1], trailing[2]);
  }
  return rules;
}

export type OutputLanguageCheck = {
  ok: boolean;
  reason: string | null;
  counts: { latin: number; cjk: number; kana: number; simplified: number; traditional: number };
};

/** 单次显式语言优先；否则从笔记本 directive 的既有权威句式中恢复生效语言。 */
function normalizedLanguageLabel(value: string | null | undefined): string | undefined {
  const raw = (value || "").trim();
  if (!raw) return undefined;
  if (/^(?:en(?:[-_][A-Z]{2})?|english)$/i.test(raw)) return "English";
  if (/^(?:ja(?:[-_]JP)?|japanese|日本語)$/i.test(raw)) return "日本語";
  if (/^(?:zh[-_](?:TW|HK|Hant)|traditional(?: chinese)?|繁體中文|繁体中文)$/i.test(raw)) return "繁體中文";
  if (/^(?:zh(?:[-_](?:CN|Hans))?|simplified(?: chinese)?|简体中文|簡體中文)$/i.test(raw)) return "简体中文";
  return raw;
}

export function resolveOutputLanguageRequirement(
  explicit: string | null | undefined,
  ...directives: Array<string | null | undefined>
): string | undefined {
  const direct = normalizedLanguageLabel(explicit);
  if (direct) return direct;
  const text = directives.filter(Boolean).join("\n");
  const matches = [
    text.match(/Write the ENTIRE output in\s+(.+?)\s+only\b/i),
    text.match(/必须用[「『“\"']([^」』”\"']+)[」』”\"']撰写输出/),
    text.match(/Write ALL (?:dialogue|labels?|text) in\s+(.+?)(?:[.。\n]|$)/i),
  ];
  return normalizedLanguageLabel(matches.find(Boolean)?.[1]);
}

// 只放高频且在现代文本中区分度较高的简繁字；未命中时保持“无法判定即放行”的保守策略。
const SIMPLIFIED_MARKERS = new Set([..."这为后里发台国与门体会点时个们从开关对业东丝两严丧丰临举义乌乐乔习乡书买乱争于亏云亚产亩亲亿仅仓仪价众优伙伞伟传伤伦伪余来侧侨俭债倾偿儿党兰兴养兽冈写军农冲决况冻净准凉减凤凭击凿刘则刚创删别刹剂剑办务动励劳势区医华协单卖卢卫却厂厅历厉压厌厕县叁参双变叙叶号叹吗吨听启吴员呛呜咏咙咛响哑哒哟唤喷啸团园围图圆圣场坏块坚坛坠垒垦坝壮声壳壶处备复够头夹夺奋奖奥妇妈孙学宝实审宪宫宽宾寻导寿将层届属岁岂岗岛岭岳币帅师帐带帮庄庆庐库应庙废广归录径彻忆忧怀态总恋恳恶惊惯戏户扑执扩扫扬扰抚抛抢护报担拟拢拥拨择挂挡挤挥捞损换据掳掷掸掺揽搀搁搂搅摄摆摇摊撑撵敌数斋斩断无旧显晋晒晓暂术朴机杀杂权条来杨杰极构枪标栈栋栏树样桥档梦检楼欢欧残毁毕气汇汉汤沟没沧沪泪泽洁洼浆浇测济浓涛润涂涌涩渊渐渔湾湿溃溅滚滞满滤滥滨滩潇潜澜灭灯灵灾灿炉点炼烁烂烛烟烦烧烫热爱爷牵状独狭猎猫献玛环现琐电画畅疗监盖盘着矿码砖确碍礼祸离种积称稳穷窃竞笔笼签简粮紧纠红约级纪纬纯纲纳纵纷纸纹纺纽线练组细织终绍经绑结绕绘给络绝统绢绣继续绳维绵综绿缀编缘缚缩缴罢罗罚职联肃胜胶脑脚脱脸腻腾舰艺节范荐药获莲营萧萨蓝虑虚虫虽虾蚀蚁蚂蛮补装裤袭见观规视览觉触誉计订认讨让训议讯记讲讳讽设访证评识诉词译试诚话询该详语误说请诸诺读谁课调谈谋谎谓谢谣负财责贤败账货质贩贫购贯贴贵贷贸费贺贼贾资赋赌赎赏赔赖赚赛赠赞赵赶趋跃车轨转轮软轻载较辅辆辈辉辑输辖辙边辽达迁过迈运还进远违连迟迹适选递逻遗邮邻郑酝释里鉴针钉钓钞钟钢钥钦钱钳钻铁铃铅铜铝铭银铺链销锁锅锋错锚锡锦键锻镀镇镜长门闭问闯闲间闷闸闹闻阁阅队阳阴阵阶际陆陈险随隐难雏雾静顶顷项顺须顾顿颁颂预领频题颜风飞饥饭饮饰饱饼馆马驳驶驻驾骂验骑骗骚骤鱼鲜鸟鸡鸣鸭鸿鹤鹰麦黄齐齿龄龙龟"]);
const TRADITIONAL_MARKERS = new Set([..."這為後裡發臺國與門體會點時個們從開關對業東絲兩嚴喪豐臨舉義烏樂喬習鄉書買亂爭於虧雲亞產畝親億僅倉儀價眾優夥傘偉傳傷倫偽餘來側僑儉債傾償兒黨蘭興養獸岡寫軍農衝決況凍淨準涼減鳳憑擊鑿劉則剛創刪別剎劑劍辦務動勵勞勢區醫華協單賣盧衛卻廠廳歷厲壓厭廁縣叁參雙變敘葉號嘆嗎噸聽啟吳員嗆嗚詠嚨嚀響啞噠喲喚噴嘯團園圍圖圓聖場壞塊堅壇墜壘墾壩壯聲殼壺處備復夠頭夾奪奮獎奧婦媽孫學寶實審憲宮寬賓尋導壽將層屆屬歲豈崗島嶺嶽幣帥師帳帶幫莊慶廬庫應廟廢廣歸錄徑徹憶憂懷態總戀懇惡驚慣戲戶撲執擴掃揚擾撫拋搶護報擔擬攏擁撥擇掛擋擠揮撈損換據擄擲撣摻攬攙擱摟攪攝擺搖攤撐攆敵數齋斬斷無舊顯晉曬曉暫術樸機殺雜權條來楊傑極構槍標棧棟欄樹樣橋檔夢檢樓歡歐殘毀畢氣匯漢湯溝沒滄滬淚澤潔窪漿澆測濟濃濤潤塗湧澀淵漸漁灣濕潰濺滾滯滿濾濫濱灘瀟潛瀾滅燈靈災燦爐點煉爍爛燭煙煩燒燙熱愛爺牽狀獨狹獵貓獻瑪環現瑣電畫暢療監蓋盤著礦碼磚確礙禮禍離種積稱穩窮竊競筆籠簽簡糧緊糾紅約級紀緯純綱納縱紛紙紋紡紐線練組細織終紹經綁結繞繪給絡絕統絹繡繼續繩維綿綜綠綴編緣縛縮繳罷羅罰職聯肅勝膠腦腳脫臉膩騰艦藝節範薦藥獲蓮營蕭薩藍慮虛蟲雖蝦蝕蟻螞蠻補裝褲襲見觀規視覽覺觸譽計訂認討讓訓議訊記講諱諷設訪證評識訴詞譯試誠話詢該詳語誤說請諸諾讀誰課調談謀謊謂謝謠負財責賢敗賬貨質販貧購貫貼貴貸貿費賀賊賈資賦賭贖賞賠賴賺賽贈贊趙趕趨躍車軌轉輪軟輕載較輔輛輩輝輯輸轄轍邊遼達遷過邁運還進遠違連遲跡適選遞邏遺郵鄰鄭醞釋裡鑒針釘釣鈔鐘鋼鑰欽錢鉗鑽鐵鈴鉛銅鋁銘銀鋪鏈銷鎖鍋鋒錯錨錫錦鍵鍛鍍鎮鏡長門閉問闖閒間悶閘鬧聞閣閱隊陽陰陣階際陸陳險隨隱難雛霧靜頂頃項順須顧頓頒頌預領頻題顏風飛飢飯飲飾飽餅館馬駁駛駐駕罵驗騎騙騷驟魚鮮鳥雞鳴鴨鴻鶴鷹麥黃齊齒齡龍龜"]);

/**
 * 保守的输出语言一致性检查：只有脚本明显相反才拒绝；短标签、缩写、专名和简繁不含
 * 判别字的文本一律放行。调用方应只传“用户可见文字”，不要把 JSON/XML 语法算进去。
 */
export function checkOutputLanguage(
  output: string,
  language: string | null | undefined
): OutputLanguageCheck {
  const requested = normalizedLanguageLabel(language) || "";
  const sample = (output || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/#[0-9a-f]{3,8}\b/gi, " ")
    .replace(/\b[A-Z0-9._-]{2,}\b/g, " ");
  let latin = 0, cjk = 0, kana = 0, simplified = 0, traditional = 0;
  for (const char of sample) {
    if (/[A-Za-z]/.test(char)) latin++;
    else if (/[\u3040-\u30ff]/.test(char)) kana++;
    else if (/[\u3400-\u9fff]/.test(char)) {
      cjk++;
      if (SIMPLIFIED_MARKERS.has(char)) simplified++;
      if (TRADITIONAL_MARKERS.has(char)) traditional++;
    }
  }
  const counts = { latin, cjk, kana, simplified, traditional };
  const meaningful = latin + cjk + kana;
  if (!requested || meaningful < 12) return { ok: true, reason: null, counts };
  const fail = (reason: string): OutputLanguageCheck => ({ ok: false, reason, counts });
  if (/English/i.test(requested)) {
    if (cjk + kana >= 8 && latin < (cjk + kana) * 1.5) return fail("输出主体不是 English");
    return { ok: true, reason: null, counts };
  }
  if (/日本語|Japanese/i.test(requested)) {
    if (kana >= 2) return { ok: true, reason: null, counts };
    if (latin >= 30 && cjk < 4) return fail("输出主体不是日本語");
    // 仅汉字短标题在日文中合法，无法可靠区分时保守放行。
    return { ok: true, reason: null, counts };
  }
  if (/繁體|繁体|Traditional/i.test(requested)) {
    if (kana >= 2) return fail("输出混入日文假名");
    // 把 OpenAI / GPT / Microsoft 等长英文专名视为可保留词；只在
    // 几乎没有汉字时才判定“主体为英文”，避免中文技术文案误拒。
    if (latin >= 30 && cjk < 4) return fail("输出主体不是繁體中文");
    if (simplified >= 3 && simplified > traditional * 1.5) return fail("输出明显偏向简体中文");
    return { ok: true, reason: null, counts };
  }
  if (/简体|簡體|Simplified/i.test(requested)) {
    if (kana >= 2) return fail("输出混入日文假名");
    if (latin >= 30 && cjk < 4) return fail("输出主体不是简体中文");
    if (traditional >= 3 && traditional > simplified * 1.5) return fail("输出明显偏向繁體中文");
    return { ok: true, reason: null, counts };
  }
  return { ok: true, reason: null, counts };
}

export function missingSupportedVerbatimPhrases(
  output: string,
  instruction: string | null | undefined,
  sourcesText: string
): string[] {
  return requiredVerbatimPhrases(instruction).filter(
    (phrase) => sourcesText.includes(phrase) && !output.includes(phrase)
  );
}

type CorpusBlock = { title: string; body: string };

function corpusBlocks(corpus: string): CorpusBlock[] {
  return corpus.split(/\n\n---\n\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    const title = (lines.shift() || "").replace(/^#\s*/, "").trim();
    return { title, body: lines.join("\n") };
  }).filter((block) => block.title);
}

function stableScopeTerms(block: CorpusBlock): string[] {
  const terms = new Set<string>([block.title]);
  for (const match of block.body.matchAll(/[\p{L}]{1,16}[-_]\d[\dA-Za-z._-]*/gu)) terms.add(match[0]);
  for (const match of block.body.matchAll(/\b[A-Z][A-Z0-9._-]{2,}\b/g)) terms.add(match[0]);
  return [...terms];
}

function explicitNegativeScopeTerms(request: string): string[] {
  const captures: string[] = [];
  const patterns = [
    /(?:忽略|排除|剔除|去掉|跳过|不要(?:包含|提及|涉及|输出|使用)?|不得(?:包含|提及|涉及|输出|使用)?|不(?:要)?考(?:察|查)?|不围绕)\s*(?:来源|主题|内容)?\s*(?:为|[:：])?\s*([^，,。；;！!？?\n]{1,100})/gu,
    /(?:ignore|exclude|omit|skip|without|do\s+not\s+(?:include|mention|cover|use)|don't\s+(?:include|mention|cover|use))\s+(?:the\s+)?([^,.;!?\n]{1,100})/gi,
  ];
  for (const pattern of patterns) {
    for (const match of request.matchAll(pattern)) {
      for (const raw of match[1].split(/\s*(?:、|\/|和|与|及|\band\b)\s*/i)) {
        const term = raw
          .replace(/^[\s「『“\"'`]+|[\s」』”\"'`]+$/g, "")
          .replace(/^(?:the\s+)?(?:source|topic|来源|主题|内容)\s*/i, "")
          .replace(/\s*(?:相关)?(?:source|topic|content|来源|主题|内容)$/i, "")
          .trim();
        if (term && !/^(?:其他|其它|无关)(?:来源|主题|内容)?$|^others?$|^unrelated(?:\s+(?:sources?|topics?))?$/i.test(term)) {
          captures.push(term);
        }
      }
    }
  }
  return [...new Set(captures)];
}

/** 用户明确包含/排除某来源或同源术语时，列出最终输出不得泄漏的稳定标识。 */
export function excludedScopeTerms(corpus: string, instruction: string | null | undefined): string[] {
  const request = (instruction || "").trim();
  if (!request) return [];
  const blocks = corpusBlocks(corpus);
  const terms = new Set<string>();
  const narrows = /(?:仅|只|聚焦|围绕|限定|only|focus)/i.test(request);
  const included = narrows ? blocks.filter((block) => request.includes(block.title)) : [];
  if (included.length) {
    const includedTitles = new Set(included.map((block) => block.title));
    for (const block of blocks) {
      if (!includedTitles.has(block.title)) for (const term of stableScopeTerms(block)) terms.add(term);
    }
  }
  for (const negative of explicitNegativeScopeTerms(request)) {
    const matchedBlocks = blocks.filter(
      (block) => block.title === negative || block.title.includes(negative) || negative.includes(block.title)
    );
    if (matchedBlocks.length) {
      for (const block of matchedBlocks) for (const term of stableScopeTerms(block)) terms.add(term);
      continue;
    }
    // 同一来源内的明确禁词：只接受在语料中实际出现的词，避免把任意提示文本误当来源范围。
    if (corpus.includes(negative)) terms.add(negative);
  }
  return [...terms].filter((term) => term.length >= 2);
}

export function mentionedExcludedScopeTerms(
  output: string,
  corpus: string,
  instruction: string | null | undefined
): string[] {
  return excludedScopeTerms(corpus, instruction).filter((term) => output.includes(term));
}

/** 删除明确被用户排除的 Markdown 段落/列表/表格行或句子，不改写其余已生成内容。 */
export function pruneExcludedScopeText(
  output: string,
  corpus: string,
  instruction: string | null | undefined
): { text: string; removed: number } {
  const terms = excludedScopeTerms(corpus, instruction);
  if (!terms.length || !terms.some((term) => output.includes(term))) return { text: output, removed: 0 };
  const contains = (text: string) => terms.some((term) => text.includes(term));
  const lines = output.split(/\r?\n/);
  const kept: string[] = [];
  let skipHeadingLevel = 0;
  let removed = 0;
  for (const line of lines) {
    const heading = line.match(/^\s*(#{1,6})\s+/);
    if (heading) {
      const level = heading[1].length;
      if (skipHeadingLevel && level <= skipHeadingLevel) skipHeadingLevel = 0;
      if (contains(line)) {
        skipHeadingLevel = level;
        removed++;
        continue;
      }
    } else if (skipHeadingLevel) {
      removed++;
      continue;
    }
    if (contains(line) && /^\s*(?:[-+*]\s+|\|)/.test(line)) {
      removed++;
      continue;
    }
    if (!contains(line)) {
      kept.push(line);
      continue;
    }
    const sentences = line.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [line];
    const safe = sentences.filter((sentence) => !contains(sentence));
    removed += sentences.length - safe.length;
    if (safe.join("").trim()) kept.push(safe.join("").trim());
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}
