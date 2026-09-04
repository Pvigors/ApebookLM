// x-data-spreadsheet 的 dist 产物是 IIFE(副作用挂到 window.x_spreadsheet),
// 这里只为两个深路径导入提供空模块声明;实际 API 经 window 访问,类型见
// components/TableSheet.tsx 中的本地定义。
declare module "x-data-spreadsheet/dist/xspreadsheet.js";
declare module "x-data-spreadsheet/dist/locale/zh-cn.js";
declare module "x-data-spreadsheet/dist/xspreadsheet.css";
