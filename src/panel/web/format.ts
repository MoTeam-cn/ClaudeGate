/**
 * 面板运行时 · 格式化
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const FORMAT_JS = String.raw`
/* 时间一律按**浏览器所在时区**渲染。
   网关送过来的都是 unix 秒（与时区无关），下面这些 getXxx 取的就是本地时区，
   所以不用做任何换算 —— 换台机器、换个时区，显示自然跟着变。
   但「08:00」这个数字本身看不出是哪儿的八点，所以再给一个带标注的版本给 title 用。 */
function fmtTime(ms){
  if(!ms) return "-";
  var d = new Date(ms);
  function p(n){ return n<10?"0"+n:""+n; }
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
}
/** 当前浏览器时区的偏移标签，例如 UTC+08:00 */
function tzLabel(){
  var off = -new Date().getTimezoneOffset();
  var sign = off < 0 ? "-" : "+";
  var a = Math.abs(off), h = Math.floor(a/60), m = a%60;
  return "UTC" + sign + (h<10?"0":"")+h + ":" + (m<10?"0":"")+m;
}
function tzName(){
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch(e){ return ""; }
}
/** 带时区标注的完整时间：2026-10-11 08:00:00 (UTC+08:00 Asia/Shanghai) */
function fmtTimeTz(ms){
  if(!ms) return "-";
  var n = tzName();
  return fmtTime(ms) + " (" + tzLabel() + (n ? " " + n : "") + ")";
}
function fmtAgo(ms){
  if(!ms) return "-";
  var s = Math.floor((Date.now()-ms)/1000);
  if(s<0) s=0;
  if(s<60) return s+" 秒前";
  if(s<3600) return Math.floor(s/60)+" 分钟前";
  if(s<86400) return Math.floor(s/3600)+" 小时前";
  return Math.floor(s/86400)+" 天前";
}
function fmtNum(n){
  if(n===null||n===undefined) return "0";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtDur(ms){
  if(ms===null||ms===undefined) return "-";
  if(ms<1000) return ms+" ms";
  if(ms<60000) return (Math.round(ms/100)/10)+" s";
  return Math.floor(ms/60000)+" 分 "+Math.floor((ms%60000)/1000)+" 秒";
}
`;
