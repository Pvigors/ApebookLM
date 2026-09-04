// 官网访客首页静态骨架(由定稿 demo t6 迁移)。服务端直出利于微信审核与 SEO;
// 行为全部在 landing-behavior.ts,本文件不含脚本。

export const LANDING_HTML = `<section id="ld">
  <div class="ld-bg"></div>
  <div class="ld-sweep"></div>
  <header class="ld-nav">
    <div class="ld-navin">
      <a class="ld-brand" href="/"><span class="ld-logosq"><span class="ld-mark"></span></span><b>猿笔记</b></a>
      <button type="button" class="ld-navbtn" data-login aria-label="登录"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.6" stroke="currentColor" stroke-width="1.7"/><path d="M4.8 20c0-3.6 3.2-6 7.2-6s7.2 2.4 7.2 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
    </div>
  </header>

  <!-- 第 1 屏 · Hero -->
  <div class="ld-sect" id="ld-s1"><div class="ld-wrap ld-hero"><div class="ld-herog">
    <div class="ld-heroL">
      <div class="ld-fx"><span class="ld-eyebrow"><s></s>回答带引用 · 句句可回溯</span></div>
      <h1 class="ld-fx ld-serif ld-title" style="--d:.08s">把<span class="ld-bw" id="ld-bwSrc"><button class="ld-blank" type="button" id="ld-bSrc"><span class="ld-bt" id="ld-btSrc">公众号合集</span><svg viewBox="0 0 12 12" fill="none"><path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><span class="ld-menu" id="ld-mSrc"></span></span>，变成<span class="ld-bw" id="ld-bwArt"><button class="ld-blank" type="button" id="ld-bArt"><span class="ld-bt" id="ld-btArt">一集播客</span><svg viewBox="0 0 12 12" fill="none"><path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><span class="ld-menu" id="ld-mArt"></span></span>。</h1>
      <p class="ld-fx ld-sub" style="--d:.16s">把散落各处的资料汇进同一个笔记本，围绕原文提问，回答带引用、随时回到出处；再一键智能生成 19 种制品。</p>
      <div class="ld-fx ld-ctarow" style="--d:.22s">
        <a class="ld-cta" href="/login" data-login>开始使用</a>
        <a class="ld-ghost" href="/login" data-login data-preview-direct>已有账号？登录</a>
      </div>
      <div class="ld-fx ld-sup" style="--d:.3s"><em>已支持</em>
        <span class="ld-pill"><s></s>网页</span><span class="ld-pill"><s></s>PDF</span><span class="ld-pill"><s></s>公众号</span>
        <span class="ld-pill"><s></s>B站</span><span class="ld-pill"><s></s>播客</span><span class="ld-pill"><s></s>Obsidian</span>
      </div>
    </div>
    <div class="ld-heroR ld-fx" style="--d:.2s">
      <div class="ld-win">
        <div class="ld-winbar">
          <span class="ld-wdots"><i></i><i></i><i></i></span>
          <span class="ld-addr"><svg viewBox="0 0 12 12" fill="none"><rect x="2" y="5" width="8" height="5.5" rx="1.4" stroke="currentColor" stroke-width="1.2"/><path d="M4 5V3.8a2 2 0 014 0V5" stroke="currentColor" stroke-width="1.2"/></svg>notes.local/我的笔记本</span>
        </div>
        <div class="ld-winbody" id="ld-winbody">
          <div class="ld-col"><div class="ld-colh">来源<em id="ld-srcN">3</em></div><div id="ld-slist"></div></div>
          <div class="ld-col ld-colc"><div class="ld-colh">对话<em>带引用</em></div>
            <div class="ld-chat">
              <div class="ld-bq" id="ld-bq"></div>
              <div class="ld-typing" id="ld-t1"><i></i><i></i><i></i></div>
              <div class="ld-ba" id="ld-ba1"></div>
              <div class="ld-ba" id="ld-ba2"></div>
              <div class="ld-bq ld-bq2" id="ld-fq"></div>
              <div class="ld-typing" id="ld-t2"><i></i><i></i><i></i></div>
              <div class="ld-ba" id="ld-fba"></div>
            </div>
            <div class="ld-cin">继续追问…<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 11.2L20.5 4l-7.2 17-2.2-7.2-7.6-2.6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></div>
          </div>
          <div class="ld-col"><div class="ld-colh">制品<em>19 种</em></div><div id="ld-tiles"></div></div>
        </div>
        <div class="ld-wfoot" id="ld-wfoot"><s></s><span id="ld-wstat">已就绪</span><em>句句可回溯</em></div>
      </div>
    </div>
  </div></div></div>

  <!-- 第 2 屏 · 引用回溯剧场 -->
  <div class="ld-sect" id="ld-s2"><div class="ld-wrap ld-thx">
    <div class="ld-shead ld-fx"><h2 class="ld-serif">答案有出处，句句可回溯</h2><p>每个回答都带引用角标，点一下，直接回到原文的那一页、那一段。</p></div>
    <div class="ld-duo ld-fx" id="ld-duo" style="--d:.12s">
      <svg class="ld-linksvg" id="ld-linksvg"><path class="ld-linkpath" id="ld-linkpath" d=""/></svg>
      <div class="ld-card ld-cardL">
        <div class="ld-cardh"><span class="ld-chip">对话</span>学习方法研究综述</div>
        <div class="ld-cbody">
          <div class="ld-qline"><span class="ld-qav">我</span><p><span id="ld-typed"></span><span class="ld-caret" id="ld-tcaret"></span></p></div>
          <div id="ld-asents">
            <div class="ld-asent">间隔练习比集中复习更有利于长期保持。<button class="ld-mk" type="button">1</button></div>
            <div class="ld-asent">主动回忆能强化提取路径，与间隔安排结合时效果更稳定。<button class="ld-mk" type="button">2</button></div>
            <div class="ld-asent">材料同时提醒：任务难度与学习阶段会影响最佳复习间隔。<button class="ld-mk" type="button">3</button></div>
          </div>
        </div>
      </div>
      <div class="ld-card ld-cardR">
        <div class="ld-cardh"><span class="ld-chip doc">PDF</span>学习方法研究综述.pdf · 第 <i class="ld-pg" id="ld-pg">42</i> 页</div>
        <div class="ld-docwrap">
          <div class="ld-doc" id="ld-doc">
            <h4>三、间隔练习与主动回忆（节选）</h4>
            <p class="ld-para">长期记忆并不取决于一次学习投入多长时间，而更依赖信息在不同时间点被重新提取和加工。集中复习容易产生熟悉感，却不一定形成稳定的提取路径。</p>
            <p class="ld-para" id="ld-p1">多项对照研究表明，把同样的学习时长分散到若干次复习中，延迟测验的保持效果通常更好。复习间隔应随掌握程度逐步拉长，而不是固定不变。</p>
            <p class="ld-para">主动回忆要求学习者先合上材料，用问题、复述或闪卡尝试提取答案，再回到原文核对。提取中的适度困难有助于暴露真正的知识缺口。</p>
            <div class="ld-pagefoot">— 42 —</div>
            <p class="ld-para" id="ld-p2">将两种方法结合时，可以先按间隔计划安排复习节点，每次复习先进行闭卷自测，再只针对答错或犹豫的部分回看资料。这样能把复习时间集中在尚未掌握的内容上。</p>
            <p class="ld-para">实践中可从次日、三日后和一周后开始，再根据回忆表现动态调整。能够轻松答出的内容延长间隔，频繁出错的内容缩短间隔并重新理解。</p>
            <div class="ld-pagefoot">— 43 —</div>
            <p class="ld-para" id="ld-p3">最佳间隔没有适用于所有人的固定答案。材料难度、已有知识、考试日期与目标保持时间都会改变安排，应根据实际回忆结果而不是主观熟悉感进行调整。</p>
            <p class="ld-para">因此，稳定的方法不是机械照抄某个日程，而是持续记录自测结果，并用这些证据调整下一次复习时间。</p>
            <div class="ld-pagefoot">— 44 —</div>
          </div>
          <span class="ld-sbar" id="ld-sbar"><i id="ld-sthumb"></i></span>
        </div>
      </div>
    </div>
  </div></div>

  <!-- 第 3 屏 · 三步实景「聚焦接力」 + 19 制品对流 -->
  <div class="ld-sect" id="ld-s3"><div class="ld-wrap ld-steps">
    <div class="ld-shead ld-fx"><h2 class="ld-serif">三步，从一堆资料到一份成稿</h2><p>不是流程示意图——这就是产品本来的样子，三步在同一个窗口里接力完成。</p></div>
    <div class="ld-fx ld-stage" style="--d:.12s">
      <span class="ld-badge" id="ld-badge" aria-hidden="true"><b class="ld-serif" id="ld-bnum">壹</b><span id="ld-bname">汇入来源</span></span>
      <div class="ld-win ld-swin">
        <div class="ld-winbar">
          <span class="ld-wdots"><i></i><i></i><i></i></span>
          <span class="ld-addr"><svg viewBox="0 0 12 12" fill="none"><rect x="2" y="5" width="8" height="5.5" rx="1.4" stroke="currentColor" stroke-width="1.2"/><path d="M4 5V3.8a2 2 0 014 0V5" stroke="currentColor" stroke-width="1.2"/></svg>notes.local/新建笔记本</span>
        </div>
        <div class="ld-winbody">
          <div class="ld-col ld-fcol focus" id="ld-fc1">
            <div class="ld-colh">来源<em id="ld-fsrcN">0</em></div>
            <div id="ld-fslist"></div>
          </div>
          <div class="ld-col ld-colc ld-fcol" id="ld-fc2">
            <div class="ld-colh">对话<em>带引用</em></div>
            <div class="ld-chat">
              <div class="ld-bq" id="ld-fbq">这几份资料对「订阅化」的判断一致吗？</div>
              <div class="ld-typing" id="ld-ft"><i></i><i></i><i></i></div>
              <div class="ld-ba" id="ld-fba1">白皮书与专栏观点一致：订阅化是未来三年的主线<i class="ld-cite">1</i><i class="ld-cite">2</i>。</div>
              <div class="ld-ba" id="ld-fba2">但访谈中专家提醒：中小客户的持续使用意愿仍需分层验证<i class="ld-cite">3</i>。</div>
            </div>
            <div class="ld-cin">继续追问…<svg viewBox="0 0 24 24" fill="none"><path d="M3.5 11.2L20.5 4l-7.2 17-2.2-7.2-7.6-2.6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></div>
          </div>
          <div class="ld-col ld-fcol" id="ld-fc3">
            <div class="ld-colh">制品<em>19 种</em></div>
            <div id="ld-ftiles"></div>
          </div>
        </div>
        <div class="ld-wfoot" id="ld-fw"><s></s><span id="ld-fwstat">新建笔记本 · 正在汇入来源…</span><em>三步 · 同一个窗口</em></div>
      </div>
      <div class="ld-sdesc" id="ld-sdesc">网页、PDF、公众号、B站、播客、Obsidian，一键收进同一个笔记本。</div>
    </div>
    <div class="ld-fx ld-mqblock" style="--d:.18s">
      <div class="ld-mq"><div class="ld-mqrow a" id="ld-mqa"></div><div class="ld-mqrow b" id="ld-mqb"></div></div>
      <div class="ld-mqcap">19 种制品，可由资料或明确需求生成，关键要求均可追溯</div>
    </div>
  </div></div>

  <!-- 第 4 屏 · 登录收尾 -->
  <div class="ld-sect" id="ld-s4"><div class="ld-wrap ld-fin" id="ld-fin">
    <h2 class="ld-fx ld-serif">把今天读到的，<br>变成真正属于你的。</h2>
    <div class="ld-fx" style="--d:.1s"><span class="ld-live"><s></s>今天已有<b id="ld-count">1,293</b>份笔记本在生成</span></div>
    <div class="ld-fx" style="--d:.18s">
      <a class="ld-bigcta" href="/login" id="ld-finbtn" data-login>开始使用<span class="ld-rip" id="ld-rip"></span></a>
    </div>
    <p class="ld-fx ld-finnote" style="--d:.26s">网页端开箱即用 · 无需下载安装</p>
    

    <div class="ld-cursor" id="ld-cursor" aria-hidden="true"><svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg"><path d="M5.8 3v16.6l4.3-3.9 3 6.9 4.2-1.8-3-6.7h6.6z" fill="#111214" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg></div>
  </div></div>

  <footer class="ld-foot">
    <div class="ld-fbrand"><span class="ld-logosq sm"><span class="ld-mark"></span></span><b>猿笔记</b></div>
    <p>© 2026 ApebookLM contributors · <a href="/legal/agreement">使用说明</a> · <a href="/legal/privacy">隐私说明</a></p>
  </footer>
</section>`;
