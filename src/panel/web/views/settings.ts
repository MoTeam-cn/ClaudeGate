/**
 * 面板视图 · 设置
 *
 * 它只是一段字符串：面板零依赖、零构建，服务端把片段按 index.ts 里的顺序拼成
 * 一个 bundle 再下发给浏览器。
 *
 * 四张卡片拆在 settings/ 下，这里留 renderSettings 与拼装。拼接顺序与原文件一致；
 * 浏览器侧全是函数声明，提升规则保证调用顺序没问题。
 * 拆分原因：单文件曾达 384 行。
 */
import { MODEL_CARD_JS } from "./settings/model.ts";
import { EGRESS_CARD_JS } from "./settings/egress.ts";
import { LIMITS_CARD_JS } from "./settings/limits.ts";
import { ADMIN_JS } from "./settings/admin.ts";

export const SETTINGS_JS =
  MODEL_CARD_JS +
  EGRESS_CARD_JS +
  String.raw`
function renderSettings(box){
  var host = h("div");
  box.appendChild(host);
  CG.onRefresh(function(){
    return CG.api("settings").then(function(s){
      CG.paint(host, ["guardMode","stegoMode","reqIdInResponse","injectMissing","logRetentionDays","runtimeLogMax"].map(function(k){ return s[k]; }).join("|"), function(host){
      var guard = CG.selectBox([
        { value:"strict", label:"strict（缺规范头直接 403）" },
        { value:"lenient", label:"lenient（缺头放行并告警）" },
        { value:"off", label:"off（不校验）" }
      ], { value:s.guardMode });
      var stego = CG.selectBox([
        { value:"block", label:"block（拦截并说明）" },
        { value:"strip", label:"strip（清洗后转发）" },
        { value:"log", label:"log（只记日志）" },
        { value:"off", label:"off（不检测）" }
      ], { value:s.stegoMode });
      var reqid = CG.selectBox([
        { value:"error", label:"error（只在错误响应里带）" },
        { value:"always", label:"always（成功也带）" },
        { value:"off", label:"off" }
      ], { value:s.reqIdInResponse });
      var injectBox = CG.switchBox(s.injectMissing);
      var inject = injectBox.input;
      var keep = h("input",{class:"el-input__inner",type:"number",value:s.logRetentionDays});
      var maxrt = h("input",{class:"el-input__inner",type:"number",value:s.runtimeLogMax});

      host.appendChild(card("策略设置", h("div",{},[
        h("div",{class:"cg-row"},[
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"请求头守卫"}), guard.el ]),
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"隐写拦截"}), stego.el ]),
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"请求 ID 回传"}), reqid.el ])
        ]),
        h("div",{class:"el-form-item"},[ h("div",{class:"el-form-item__label",text:"缺失规范头时自动注入"}), injectBox.el ]),
        h("div",{class:"cg-row"},[
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"请求日志保留天数"}), keep ]),
          h("div",{class:"el-form-item cg-col"},[ h("div",{class:"el-form-item__label",text:"运行日志上限条数"}), maxrt ])
        ]),
        h("button",{class:"el-button el-button--primary",text:"保存设置",onclick:function(){
          CG.api("settings.save",{
            guardMode:guard.value, stegoMode:stego.value, reqIdInResponse:reqid.value,
            injectMissing:inject.checked, logRetentionDays:Number(keep.value)||14, runtimeLogMax:Number(maxrt.value)||20000
          }).then(function(){ CG.toast("设置已保存","success"); }).catch(CG.showErr);
        }})
      ])));

      host.appendChild(egressCard());
      host.appendChild(modelCard());
      host.appendChild(adminKeyCard());
      host.appendChild(limitsCard());
      return s;
    });
    });
  });
}

/* 模型上下文限制卡片。每个模型一行：上下文窗口 + 最大输出。
   留空 = 用兜底；兜底也留空 = 不限制。 */
` +
  LIMITS_CARD_JS +
  ADMIN_JS;
