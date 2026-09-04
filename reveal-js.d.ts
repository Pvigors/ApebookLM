// reveal.js 不带 TS 声明;我们仅动态 import 它的默认导出(构造器)。宽松声明即可。
declare module "reveal.js" {
  const Reveal: new (el: HTMLElement, opts?: Record<string, unknown>) => {
    initialize: () => Promise<void>;
    destroy: () => void;
    layout: () => void;
  };
  export default Reveal;
}
