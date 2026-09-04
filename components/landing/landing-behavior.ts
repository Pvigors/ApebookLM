/* eslint-disable @typescript-eslint/no-explicit-any */
// 官网访客首页的全部交互行为(自定稿 demo t6 机器移植,勿手工重排;
// 改视觉先在 demo 里跟用户对齐,再重新移植,避免两边漂移)。
//
// 铁律 21:预览/后台标签页会节流 rAF,所有动效一律用 setInterval 驱动;
// 定时器 / document 级监听 / Observer 统一登记,卸载时全回收。

export function initLanding(pane: HTMLElement): () => void {
  const timers: number[] = [];
  const iv = (fn: () => void, ms: number) => { const id = window.setInterval(fn, ms); timers.push(id); return id; };
  const to = (fn: () => void, ms: number) => { const id = window.setTimeout(fn, ms); timers.push(id); return id; };
  const docHandlers: Array<[string, EventListener]> = [];
  const onDoc = (type: string, fn: EventListener) => { document.addEventListener(type, fn); docHandlers.push([type, fn]); };
  const observers: Array<{ disconnect(): void }> = [];
  const track = <T extends { disconnect(): void }>(o: T): T => { observers.push(o); return o; };
  const $ = (sel: string, el?: ParentNode | null): any => (el || pane).querySelector(sel);
  const $$ = (sel: string, el?: ParentNode | null): any[] => Array.prototype.slice.call((el || pane).querySelectorAll(sel));
  var wideMQ: MediaQueryList = window.matchMedia ? window.matchMedia('(min-width:921px)') : ({ matches: true } as MediaQueryList);
  var thSeen=false,stSeen=false,fnSeen=false;

  /* ---------- 图标 ---------- */
  var IC={
    mp:'<svg viewBox="0 0 24 24" fill="none"><path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H9l-4 4v-4a2 2 0 01-1-1.7V6z" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1.2" fill="currentColor"/><circle cx="15" cy="10" r="1.2" fill="currentColor"/></svg>',
    pdf:'<svg viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6V3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v4h4M9 13h6M9 16.5h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    play:'<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="13" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="M8 3l3 3M16 3l-3 3M10.5 10.5l4 2-4 2v-4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    web:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" stroke="currentColor" stroke-width="2"/></svg>',
    mic:'<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="2"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    doc:'<svg viewBox="0 0 24 24" fill="none"><rect x="5" y="3" width="14" height="18" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    card:'<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="8" width="14" height="11" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 5h13v11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    map:'<svg viewBox="0 0 24 24" fill="none"><circle cx="5.5" cy="12" r="2.5" stroke="currentColor" stroke-width="2"/><circle cx="18.5" cy="5.5" r="2.2" stroke="currentColor" stroke-width="2"/><circle cx="18.5" cy="12" r="2.2" stroke="currentColor" stroke-width="2"/><circle cx="18.5" cy="18.5" r="2.2" stroke="currentColor" stroke-width="2"/><path d="M8 12h8.3M8 11l8-4.5M8 13l8 4.5" stroke="currentColor" stroke-width="1.6"/></svg>',
    quiz:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M9.6 9.3a2.4 2.4 0 114 1.7c-.8.8-1.6 1.2-1.6 2.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.1" fill="currentColor"/></svg>',
    list:'<svg viewBox="0 0 24 24" fill="none"><path d="M8 6h12M8 12h12M8 18h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="4" cy="6" r="1.3" fill="currentColor"/><circle cx="4" cy="12" r="1.3" fill="currentColor"/><circle cx="4" cy="18" r="1.3" fill="currentColor"/></svg>',
    pres:'<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M12 16v3M8.5 21h7M8 12l2.5-2.5 2 1.8L16 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ok:'<svg class="ld-ok" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2L5 8.7l4.5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  var CITE=function(n?: any){return '<i class="ld-cite">'+n+'</i>'};

  /* ---------- Hero 数据 ---------- */
  var SRC=[
    {name:'公众号合集',ic:IC.mp,n:'26 篇',
     items:[['学习方法 · 合集','12 篇',IC.mp],['读书笔记手记','8 篇',IC.mp],['课程复盘笔记','6 篇',IC.mp]],
     q:'这 26 篇文章里，反复出现的学习方法有哪些？',
     a1:'共有三类：主动回忆'+CITE(1)+'、间隔练习'+CITE(2)+'和结构化笔记。',
     a2:'其中「先自测再复习」在 19 篇里被反复提到，是贯穿全部材料的主线'+CITE(3)+'。',
     fq:'哪一篇把主动回忆拆得最细？',
     fa:'《学习方法》第 7 篇：给出了从提问到复盘的完整步骤'+CITE(4)+'。'},
    {name:'长篇 PDF',ic:IC.pdf,n:'288 页',
     items:[['学习方法综述.pdf','128 页',IC.pdf],['主动回忆研究.pdf','96 页',IC.pdf],['间隔练习实验.pdf','64 页',IC.pdf]],
     q:'三份材料对长期记忆的判断一致吗？',
     a1:'基本一致：综述与实验都支持间隔练习'+CITE(1)+CITE(2)+'。',
     a2:'主动回忆研究进一步指出，自测能强化提取路径'+CITE(3)+'。',
     fq:'两种方法应该怎样结合？',
     fa:'综述第 89 页建议：按间隔安排复习，每次先闭卷自测再核对'+CITE(4)+'。'},
    {name:'B站课程',ic:IC.play,n:'54 讲',
     items:[['统计学入门','24 讲',IC.play],['论文阅读方法','18 讲',IC.play],['写作训练课','12 讲',IC.play]],
     q:'第 6 讲里讲师给出的阅读框架是什么？',
     a1:'是「三次阅读」：第一遍看结构'+CITE(1)+'，第二遍核对证据'+CITE(2)+'。',
     a2:'第三遍整理自己的问题，讲师配了完整的检查表'+CITE(3)+'。',
     fq:'这张检查表出现在第几分钟？',
     fa:'第 6 讲 14:32 起，讲了约 5 分钟'+CITE(4)+'。'},
    {name:'网页批量',ic:IC.web,n:'21 页',
     items:[['研究方法','× 9',IC.web],['公开数据集','× 7',IC.web],['技术笔记','× 5',IC.web]],
     q:'这 21 个网页里，被引用最多的结论是什么？',
     a1:'「主动提取比重复阅读更有效」被 14 个页面提及'+CITE(1)+'。',
     a2:'其中 6 个页面给出了可交叉验证的实验结果'+CITE(2)+CITE(3)+'。',
     fq:'有反对这个结论的声音吗？',
     fa:'有 2 篇技术博客持保留态度，理由是行业样本偏差'+CITE(4)+'。'}
  ];
  var TILES=[
    {t:'播客',ic:IC.mic},{t:'简报',ic:IC.doc},{t:'闪卡',ic:IC.card},
    {t:'导图',ic:IC.map},{t:'测验',ic:IC.quiz},{t:'大纲',ic:IC.list}
  ];
  var ART=[
    {name:'一集播客',tile:'播客',ti:0},
    {name:'一份简报',tile:'简报',ti:1},
    {name:'一套闪卡',tile:'闪卡',ti:2},
    {name:'一张导图',tile:'导图',ti:3}
  ];

  /* ---------- Hero：构建列表与菜单 ---------- */
  var slist=$('#ld-slist'),tiles=$('#ld-tiles'),winbody=$('#ld-winbody'),srcN=$('#ld-srcN'),
      bq=$('#ld-bq'),t1=$('#ld-t1'),ba1=$('#ld-ba1'),ba2=$('#ld-ba2'),
      fq2=$('#ld-fq'),t2=$('#ld-t2'),fba=$('#ld-fba'),
      wstat=$('#ld-wstat'),wfoot=$('#ld-wfoot'),
      btSrc=$('#ld-btSrc'),btArt=$('#ld-btArt'),
      bwSrc=$('#ld-bwSrc'),bwArt=$('#ld-bwArt'),
      mSrc=$('#ld-mSrc'),mArt=$('#ld-mArt');
  function tileHTML(t?: any, ic?: any){
    return '<div class="ld-tile"><div class="ld-trow">'+ic+'<b>'+t+'</b><span class="ld-tst"><b class="ld-tw">待生成</b><b class="ld-td">已生成</b></span></div><div class="ld-bar"><i></i></div></div>';
  }
  if(tiles) tiles.innerHTML=TILES.map(function(a?: any){return tileHTML(a.t,a.ic)}).join('');
  function buildMenu(box?: any, list?: any, onPick?: any){
    if(!box) return;
    box.innerHTML=list.map(function(o?: any, i?: any){return '<button type="button" data-i="'+i+'">'+o.name+'</button>'}).join('');
    $$('button',box).forEach(function(b?: any){
      b.addEventListener('click',function(e?: any){e.stopPropagation();onPick(+b.getAttribute('data-i'))});
    });
  }
  var si=0,ai=0,step=0,menuOpen=false;
  function markMenus(){
    if(mSrc) $$('button',mSrc).forEach(function(b?: any, i?: any){b.classList.toggle('sel',i===si)});
    if(mArt) $$('button',mArt).forEach(function(b?: any, i?: any){b.classList.toggle('sel',i===ai)});
  }
  function closeMenus(){menuOpen=false;if(bwSrc)bwSrc.classList.remove('open');if(bwArt)bwArt.classList.remove('open')}
  function toggleMenu(w?: any){
    if(!w) return;
    var was=w.classList.contains('open');closeMenus();
    if(!was){w.classList.add('open');menuOpen=true}
  }
  buildMenu(mSrc,SRC,function(i?: any){si=i;closeMenus();step=0;heroTick()});
  buildMenu(mArt,ART,function(i?: any){ai=i;closeMenus();step=0;heroTick()});
  var bS=$('#ld-bSrc'),bA=$('#ld-bArt');
  if(bS) bS.addEventListener('click',function(e?: any){e.stopPropagation();toggleMenu(bwSrc)});
  if(bA) bA.addEventListener('click',function(e?: any){e.stopPropagation();toggleMenu(bwArt)});
  onDoc('click', function(e?: any){
    if(menuOpen&&!(bwSrc&&bwSrc.contains(e.target))&&!(bwArt&&bwArt.contains(e.target))) closeMenus();
  });

  function swapText(el?: any, txt?: any){
    if(!el) return;
    el.classList.remove('swap');void el.offsetWidth;
    el.textContent=txt;el.classList.add('swap');
  }
  function setStat(txt?: any, ok?: any){
    if(wstat) wstat.textContent=txt;
    if(wfoot) wfoot.classList.toggle('ok',!!ok);
  }
  function hideBubble(el?: any){if(el){el.classList.remove('show','zap')}}
  function applyCombo(){
    var s=SRC[si],a=ART[ai];
    swapText(btSrc,s.name);swapText(btArt,a.name);
    if(srcN) srcN.textContent=s.n;
    if(slist) slist.innerHTML=s.items.map(function(it?: any){
      return '<div class="ld-sitem">'+it[2]+'<b>'+it[0]+'</b><span class="ld-sn">'+it[1]+'</span>'+IC.ok+'</div>';
    }).join('')+'<div class="ld-adds">＋ 添加来源</div>';
    if(bq) bq.textContent=s.q;
    if(ba1) ba1.innerHTML=s.a1;
    if(ba2) ba2.innerHTML=s.a2;
    if(fq2) fq2.textContent=s.fq;
    if(fba) fba.innerHTML=s.fa;
    [bq,ba1,ba2,fq2,fba].forEach(hideBubble);
    if(t1) t1.classList.remove('show');
    if(t2) t2.classList.remove('show');
    if(tiles) $$('.ld-tile',tiles).forEach(function(t?: any, i?: any){
      t.classList.remove('run','done');t.classList.toggle('hot',i===a.ti);
    });
    setStat('已就绪 · '+s.n+'来源',false);
    markMenus();
  }
  function heroTick(){
    if(menuOpen) return;
    var items=slist?$$('.ld-sitem',slist):[];
    var hot=tiles?$$('.ld-tile',tiles)[ART[ai].ti]:null;
    switch(step){
      case 0: if(winbody) winbody.classList.add('out'); break;
      case 1: applyCombo(); if(winbody) winbody.classList.remove('out'); setStat('正在读取来源…'); break;
      case 2: case 3: case 4:
        if(items[step-2]) items[step-2].classList.add('lit'); break;
      case 5: if(bq) bq.classList.add('show'); setStat('正在检索原文…'); break;
      case 6: if(t1) t1.classList.add('show'); break;
      case 7: break;                                    /* 打字指示停留 */
      case 8: if(t1) t1.classList.remove('show');
        if(ba1) ba1.classList.add('show'); setStat('正在作答 · 附引用'); break;
      case 9: if(ba1) ba1.classList.add('zap'); break;
      case 10: if(ba2) ba2.classList.add('show'); break;
      case 11: if(ba2) ba2.classList.add('zap'); break;
      case 12: if(fq2) fq2.classList.add('show'); break; /* 追问 */
      case 13: if(t2) t2.classList.add('show'); break;
      case 14: if(t2) t2.classList.remove('show');
        if(fba){fba.classList.add('show');fba.classList.add('zap')} break;
      case 15: if(hot) hot.classList.add('run'); setStat('正在生成「'+ART[ai].tile+'」…'); break;
      case 16: case 17: case 18: break;                 /* 进度条推进 */
      case 19: if(hot) hot.classList.add('done'); setStat('「'+ART[ai].tile+'」已生成',true); break;
      case 20: case 21: case 22: case 23: break;        /* 停约 1.7s */
      case 24: si=(si+1)%SRC.length; ai=(ai+1)%ART.length; step=-1; break;
    }
    step++;
  }
  applyCombo();heroTick();
  iv(heroTick,420);

  /* ---------- 第 2 屏：引用回溯剧场（页码跳动 + 拟真滚动条） ---------- */
  var typed=$('#ld-typed'),tcaret=$('#ld-tcaret'),doc=$('#ld-doc'),duo=$('#ld-duo'),
      lsvg=$('#ld-linksvg'),lpath=$('#ld-linkpath'),
      sents=$$('.ld-asent'),marks=$$('.ld-mk'),
      paras=[$('#ld-p1'),$('#ld-p2'),$('#ld-p3')],
      pgEl=$('#ld-pg'),sbar=$('#ld-sbar'),sthumb=$('#ld-sthumb');
  var TQ='这份综述里，哪种复习方式更有利于长期记忆？';
  var PAGES=[42,43,44];
  var tPhase='reset',tI=0,tN=0,curCite=-1;
  function setPg(n?: any){
    if(!pgEl) return;
    if(pgEl.textContent!==String(n)){
      pgEl.textContent=n;
      pgEl.classList.remove('pop');void pgEl.offsetWidth;pgEl.classList.add('pop');
    }
  }
  function updThumb(){
    if(!doc||!sbar||!sthumb) return;
    var max=doc.scrollHeight-doc.clientHeight,tH=sbar.clientHeight;
    if(max<=0||tH<12){sthumb.style.height='0px';return}
    var h=Math.max(24,tH*doc.clientHeight/doc.scrollHeight);
    sthumb.style.height=h+'px';
    sthumb.style.top=Math.max(0,Math.min(tH-h,doc.scrollTop/max*(tH-h)))+'px';
  }
  if(doc) doc.addEventListener('scroll',updThumb);
  function clearCite(){
    marks.forEach(function(m?: any){m.classList.remove('pulse')});
    paras.forEach(function(p?: any){if(p)p.classList.remove('lit')});
    if(lpath) lpath.classList.remove('on');
    curCite=-1;
  }
  function drawLink(k?: any){
    if(!wideMQ.matches||!duo||!lsvg||!lpath) return;
    var dr=duo.getBoundingClientRect();
    if(dr.width<10) return;
    lsvg.setAttribute('viewBox','0 0 '+Math.round(dr.width)+' '+Math.round(dr.height));
    var mk=marks[k],pa=paras[k];
    if(!mk||!pa) return;
    var mr=mk.getBoundingClientRect(),pr=pa.getBoundingClientRect();
    var x1=mr.right-dr.left+5,y1=mr.top-dr.top+mr.height/2;
    var x2=pr.left-dr.left-6,y2=pr.top-dr.top+Math.min(pr.height/2,26);
    y2=Math.max(14,Math.min(dr.height-14,y2));
    lpath.setAttribute('d','M'+x1+' '+y1+' C '+(x1+52)+' '+y1+', '+(x2-52)+' '+y2+', '+x2+' '+y2);
    lpath.classList.add('on');
  }
  function theaterReset(){
    if(typed) typed.textContent='';
    if(tcaret) tcaret.classList.remove('off');
    sents.forEach(function(s?: any){s.classList.remove('show')});
    clearCite();
    setPg(42);
    if(doc){doc.style.scrollBehavior='auto';doc.scrollTop=0;doc.style.scrollBehavior='smooth'}
    updThumb();
    tPhase='type';tI=0;tN=0;
  }
  function theaterTick(){
    if(!thSeen) return;
    if(tPhase==='reset'){theaterReset();return}
    if(tPhase==='type'){
      if(!typed){tPhase='ans';return}
      if(tI<TQ.length){typed.textContent=TQ.slice(0,tI+1);tI++}
      else{if(tcaret)tcaret.classList.add('off');tPhase='ans';tI=0;tN=0}
      return;
    }
    if(tPhase==='ans'){
      if(tN%5===0&&tI<sents.length){if(sents[tI])sents[tI].classList.add('show');tI++}
      tN++;
      if(tI>=sents.length&&tN>=sents.length*5+3){tPhase='cite';tI=0;tN=0}
      return;
    }
    if(tPhase==='cite'){
      if(tN===0){
        clearCite();curCite=tI;
        if(marks[tI]) marks[tI].classList.add('pulse');
        setPg(PAGES[tI]);
        if(wideMQ.matches&&doc&&paras[tI]) doc.scrollTop=Math.max(0,paras[tI].offsetTop-46);
        if(!wideMQ.matches&&paras[tI]) paras[tI].classList.add('lit');
      }
      if(tN===3&&wideMQ.matches){
        if(paras[tI]) paras[tI].classList.add('lit');
        drawLink(tI);
      }
      tN++;
      if(tN>=10){tN=0;tI++;if(tI>=3){tPhase='hold';tN=0}}
      return;
    }
    if(tPhase==='hold'){tN++;if(tN>=14){clearCite();tPhase='reset'}}
  }
  iv(theaterTick,150);

  /* ---------- 第 3 屏 A：三步实景「聚焦接力」 ---------- */
  var FSRC=[
    ['行业白皮书.pdf','96 页',IC.pdf],
    ['增长专栏合集','12 篇',IC.mp],
    ['专家访谈 · 视频','46 分钟',IC.play],
    ['调研纪要 · 网页','× 6',IC.web]
  ];
  var FTILES=[
    ['深度报告',IC.doc],['思维导图',IC.map],['双人播客',IC.mic],['演示文稿',IC.pres],['记忆闪卡',IC.card]
  ];
  var SNUM=['壹','贰','叁'],SNAME=['汇入来源','带引用的对话','一键智能生成'];
  var SDESC=[
    '网页、PDF、公众号、B站、播客、Obsidian，一键收进同一个笔记本。',
    '围绕原文提问，回答句句附引用角标，点一下就回到出处。',
    '深度报告、思维导图、双人播客、CAD 模型……19 种制品，选一个，直接生成。'
  ];
  var fslist=$('#ld-fslist'),ftiles=$('#ld-ftiles'),fsrcN=$('#ld-fsrcN'),
      fbq=$('#ld-fbq'),ft=$('#ld-ft'),fba1=$('#ld-fba1'),fba2=$('#ld-fba2'),
      fwstat=$('#ld-fwstat'),fw=$('#ld-fw'),
      badge=$('#ld-badge'),bnum=$('#ld-bnum'),bname=$('#ld-bname'),
      sdesc=$('#ld-sdesc'),s3=$('#ld-s3'),
      fcols=[$('#ld-fc1'),$('#ld-fc2'),$('#ld-fc3')];
  if(fslist) fslist.innerHTML=FSRC.map(function(it?: any){
    return '<div class="ld-sitem">'+it[2]+'<b>'+it[0]+'</b><span class="ld-sn">'+it[1]+'</span>'+IC.ok+'</div>';
  }).join('')+'<div class="ld-adds">＋ 添加来源</div>';
  if(ftiles) ftiles.innerHTML=FTILES.map(function(a?: any){return tileHTML(a[0],a[1])}).join('');
  function setFStat(t?: any, ok?: any){
    if(fwstat) fwstat.textContent=t;
    if(fw) fw.classList.toggle('ok',!!ok);
  }
  function focusCol(k?: any, silent?: any){
    fcols.forEach(function(c?: any, i?: any){if(c)c.classList.toggle('focus',i===k)});
    if(bnum) bnum.textContent=SNUM[k];
    if(bname) bname.textContent=SNAME[k];
    if(badge&&!silent){badge.classList.remove('swap');void badge.offsetWidth;badge.classList.add('swap')}
    if(sdesc){
      if(silent){sdesc.textContent=SDESC[k]}
      else{sdesc.classList.add('f');to(function(){sdesc.textContent=SDESC[k];sdesc.classList.remove('f')},260)}
    }
  }
  function stepReset(silent?: any){
    if(fslist) $$('.ld-sitem',fslist).forEach(function(x?: any){x.classList.remove('in','lit')});
    if(fsrcN) fsrcN.textContent='0';
    [fbq,fba1,fba2].forEach(hideBubble);
    if(ft) ft.classList.remove('show');
    if(ftiles) $$('.ld-tile',ftiles).forEach(function(x?: any){x.classList.remove('hot','run','done')});
    focusCol(0,silent);
    setFStat('新建笔记本 · 正在汇入来源…');
  }
  var fstep=1;
  stepReset(true);
  function stepTick(){
    if(!stSeen||!s3) return;
    var r=s3.getBoundingClientRect();
    if(r.top>innerHeight||r.bottom<0) return;      /* 滚出视口即暂停 */
    var its=fslist?$$('.ld-sitem',fslist):[];
    var t0=ftiles?$$('.ld-tile',ftiles)[0]:null;
    switch(fstep){
      case 0: stepReset(); break;                  /* 步一 · 来源逐条落入打勾 */
      case 1: case 2: case 3: case 4:
        var i=fstep-1;
        if(its[i]) its[i].classList.add('in');
        if(i>0&&its[i-1]) its[i-1].classList.add('lit');
        if(fsrcN) fsrcN.textContent=String(i+1);
        break;
      case 5: if(its[3]) its[3].classList.add('lit'); setFStat('4 个来源已就绪'); break;
      case 6: break;
      case 7: focusCol(1); setFStat('正在检索原文…'); break;   /* 步二 · 带引用的对话 */
      case 8: if(fbq) fbq.classList.add('show'); break;
      case 9: if(ft) ft.classList.add('show'); break;
      case 10: break;
      case 11: if(ft) ft.classList.remove('show');
        if(fba1) fba1.classList.add('show'); setFStat('正在作答 · 附引用'); break;
      case 12: if(fba1) fba1.classList.add('zap'); break;
      case 13: if(fba2) fba2.classList.add('show'); break;
      case 14: if(fba2) fba2.classList.add('zap'); break;
      case 15: break;
      case 16: focusCol(2); setFStat('正在生成「深度报告」…'); break; /* 步三 · 一键智能生成 */
      case 17: if(t0) t0.classList.add('hot'); break;
      case 18: if(t0) t0.classList.add('run'); break;
      case 19: case 20: case 21: break;            /* 进度条推进约 1.6s */
      case 22: if(t0) t0.classList.add('done'); setFStat('「深度报告」已生成',true); break;
      case 23: case 24: case 25: case 26: break;   /* 成稿停留 */
      case 27: fstep=-1; break;
    }
    fstep++;
  }
  iv(stepTick,430);

  /* ---------- 第 3 屏 B：19 制品 · 双行反向对流 ---------- */
  var GOODS=['深度报告','思维导图','双人播客','演示文稿','一页简报','记忆闪卡','随堂测验','时间线','CAD 模型','术语表','常见问答','学习指南','结构大纲','要点速览','行动清单','对比表格','金句卡片','周报速写','推文草稿'];
  var GC=['#5466d8','#d6568f','#2aa178','#cf7a36','#7d5fd8','#d6564e','#2f9bbc','#c7912f','#5b76b7','#a94eb8'];
  function fillMq(el?: any, arr?: any, off?: any){
    if(!el) return;
    var one=arr.map(function(g?: any, i?: any){
      return '<span class="ld-good" style="--gc:'+GC[(i+off)%GC.length]+'"><s></s>'+g+'</span>';
    }).join('');
    el.innerHTML=one+one;
  }
  fillMq($('#ld-mqa'),GOODS.slice(0,10),0);
  fillMq($('#ld-mqb'),GOODS.slice(10),10);

  /* ---------- 极简顶栏：滚动后显示毛玻璃 ---------- */
  var nav6=pane.querySelector('.ld-nav');
  iv(function(){ if(nav6) nav6.classList.toggle('scr', window.scrollY>40); },200);

  /* ---------- 第 4 屏：演示光标点击登录 ---------- */
  var fin=$('#ld-fin'),cur=$('#ld-cursor'),fbtn=$('#ld-finbtn'),rip=$('#ld-rip');
  var cph=0;
  function curTo(x?: any, y?: any, snap?: any){
    if(!cur) return;
    if(snap){cur.classList.add('snap');cur.style.left=x+'px';cur.style.top=y+'px';void cur.offsetWidth;cur.classList.remove('snap')}
    else{cur.style.left=x+'px';cur.style.top=y+'px'}
  }
  function cursorTick(){
    if(!fnSeen||!fin||!cur||!fbtn) return;
    var fr=fin.getBoundingClientRect();
    if(fr.width<10){return}
    var br=fbtn.getBoundingClientRect();
    var bx=br.left-fr.left+br.width/2,by=br.top-fr.top+br.height/2;
    switch(cph){
      case 0:
        curTo(Math.min(fr.width-40,bx+250),Math.min(fr.height-40,by+150),true);
        cur.classList.add('showc');break;
      case 1: cur.classList.add('mov'); curTo(bx+96,by+58); break;   /* 第一段:大步趋近 */
      case 2: case 3: break;
      case 4: curTo(bx-6,by-3); break;                                /* 第二段:指尖细调对准 */
      case 5: break;
      case 6: cur.classList.remove('mov'); fbtn.classList.add('hov'); break;
      case 7:                                    /* 按下 + 波纹 */
        fbtn.classList.add('press');cur.classList.add('down');
        if(rip){rip.classList.remove('go');void rip.offsetWidth;rip.classList.add('go')}
        break;
      case 8: fbtn.classList.remove('press');cur.classList.remove('down');break; /* 释放 */
      case 9: break;
      case 10:                                   /* 飘离 */
        fbtn.classList.remove('hov');cur.classList.add('mov');
        curTo(Math.max(24,bx-260),Math.max(24,by-130));break;
      case 11: case 12: case 13: break;
      case 14: cur.classList.remove('showc');cur.classList.remove('mov');break;
      case 20: cph=-1;break;                     /* 含约 2s 停顿后循环 */
    }
    cph++;
  }
  iv(cursorTick,300);
  var cntEl=$('#ld-count'),cnt=1293,cntTick=0,cntGaps=[5,3,7,4,6,5],cntGi=0;
  function fmtNum(n?: any){return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,',')}
  iv(function(){
    if(!cntEl||!fin) return;
    var r=fin.getBoundingClientRect();
    if(r.top>innerHeight||r.bottom<0) return;   /* 屏外不计数 */
    cntTick++;
    if(cntTick>=cntGaps[cntGi]){cntTick=0;cntGi=(cntGi+1)%cntGaps.length;cnt++;
      cntEl.textContent=fmtNum(cnt);
      cntEl.classList.remove('ld-cpop');void cntEl.offsetWidth;cntEl.classList.add('ld-cpop');}
  },1000);

  /* ---------- 滚动进场 + 演出开关 ---------- */
  var sects=$$('.ld-sect');
  if('IntersectionObserver' in window){
    var io=track(new IntersectionObserver(function(es?: any){
      es.forEach(function(e?: any){
        if(!e.isIntersecting) return;
        e.target.classList.add('visible');
        var id=e.target.id;
        if(id==='ld-s2') thSeen=true;
        if(id==='ld-s3') stSeen=true;
        if(id==='ld-s4') fnSeen=true;
        io.unobserve(e.target);
      });
    },{threshold:.18}));
    sects.forEach(function(s?: any){io.observe(s)});
  }else{
    sects.forEach(function(s?: any){s.classList.add('visible')});
    thSeen=stSeen=fnSeen=true;
  }

  /* 进场兜底(生产增补,demo 无此段):IntersectionObserver 依赖绘制,
     标签页被节流/隐藏时可能一直不回调 —— 而未进场的段落 opacity 为 0,
     一旦失效就是整屏空白。这里用定时器按矩形自行判定,全部现身后自停。 */
  var revealIv = iv(function(){
    var left = 0;
    sects.forEach(function(s?: any){
      if (s.classList.contains('visible')) return;
      var r = s.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.82 && r.bottom > 0) {
        s.classList.add('visible');
        if (s.id === 'ld-s2') thSeen = true;
        if (s.id === 'ld-s3') stSeen = true;
        if (s.id === 'ld-s4') fnSeen = true;
      } else left++;
    });
    if (!left) window.clearInterval(revealIv);
  }, 250);

  /* ---------- 尺寸初始化 / 变化（pane 初始可能 display:none） ---------- */
  if('ResizeObserver' in window){
    var ro=track(new ResizeObserver(function(){
      if(curCite>=0) drawLink(curCite);       /* 重算连线 */
      updThumb();                              /* 重算拟真滚动条 */
      if(cph>0&&cph<13) cph=0;                /* 光标演出按新布局重来 */
    }));
    ro.observe(pane);
  }

  return function cleanup() {
    timers.forEach((id) => { window.clearInterval(id); window.clearTimeout(id); });
    docHandlers.forEach(([type, fn]) => document.removeEventListener(type, fn));
    observers.forEach((o) => o.disconnect());
  };
}
