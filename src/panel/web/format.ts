/**
 * 面板运行时 · 格式化
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const FORMAT_JS = String.raw`
function fmtTime(ms){
  if(!ms) return "-";
  var d = new Date(ms);
  function p(n){ return n<10?"0"+n:""+n; }
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
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
