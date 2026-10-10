/**
 * 面板运行时 · 表格
 *
 * 从原来的面板单文件里拆出来的片段。它只是一段字符串：面板零依赖、零构建，
 * 服务端把片段按 index.ts 里的顺序拼成一个 bundle 再下发给浏览器。
 */
export const TABLE_JS = String.raw`
function table(columns, rows, opt){
  opt = opt || {};
  var state = { key:opt.sortKey||null, dir:opt.sortDir||"desc" };
  var filters = {};
  var selected = {};
  var idOf = opt.rowId || function(r){ return r.id; };

  function colOf(key){
    for(var i=0;i<columns.length;i++) if(columns[i].key===key) return columns[i];
    return null;
  }
  function filterRows(list){
    var keys = Object.keys(filters);
    if(!keys.length) return list;
    return list.filter(function(r){
      for(var i=0;i<keys.length;i++){
        var want = filters[keys[i]];
        if(!want) continue;
        var col = colOf(keys[i]);
        var get = (col && col.filterValue) || function(x){ return x[keys[i]]; };
        var v = get(r);
        v = (v===null||v===undefined) ? "" : String(v);
        if(col && col.filter && col.filter.type === "select"){
          if(v !== want) return false;
        } else if(v.toLowerCase().indexOf(String(want).toLowerCase()) === -1){
          return false;
        }
      }
      return true;
    });
  }
  function sortRows(list){
    if(!state.key) return list;
    var col = colOf(state.key);
    if(!col) return list;
    var get = col.sortValue || function(r){ return r[col.key]; };
    var copy = list.slice();
    copy.sort(function(a,b){
      var x = get(a), y = get(b);
      if(x===null||x===undefined) x = "";
      if(y===null||y===undefined) y = "";
      var n = (typeof x==="number" && typeof y==="number") ? x-y : String(x).localeCompare(String(y));
      return state.dir === "asc" ? n : -n;
    });
    return copy;
  }
  function selectedIds(){ return Object.keys(selected).filter(function(k){ return selected[k]; }); }

  var wrap = h("div",{class:"el-table-wrap"+(opt.maxHeight === false ? " is-free" : "")});
  /*
   * 筛选栏。
   *
   * 一条栏里放两种东西，视觉完全一致：
   *   · opt.toolbar —— 页面自己给的控件（服务端筛选：搜索框、下拉），带标签
   *   · columns[].filter —— 列自带的客户端筛选
   * 以前列筛选在表头下面另起一行、没有列宽约束，和表头各排各的；页面自己的
   * 筛选又另起一块 .cg-filters，同一页会出现两排长得不一样的筛选控件。
   * 现在合成一条，右侧统一放「已筛 N 项 / 清除筛选」。
   */
  var filterbar = h("div",{class:"cg-filterbar hidden"});
  var filterResets = [];
  var hasColFilters = columns.some(function(c){ return !!c.filter; });

  function buildFilterBar(){
    var items = [];
    (opt.toolbar || []).forEach(function(t){ if(t) items.push({ label:t.label, node:t.el }); });
    columns.forEach(function(c){ if(c.filter) items.push({ col:c }); });
    if(!items.length) return;
    filterbar.className = "cg-filterbar";
    filterResets = [];

    items.forEach(function(it){
      var item = h("div",{class:"cg-filterbar__item"});
      if(it.node){
        if(it.label) item.appendChild(h("span",{class:"cg-filterbar__label",text:it.label}));
        item.appendChild(it.node);
        filterbar.appendChild(item);
        return;
      }
      var c = it.col;
      item.appendChild(h("span",{class:"cg-filterbar__label",text:c.label}));
      if(c.filter.type === "slot"){
        item.appendChild(c.filter.el);
      } else if(c.filter.type === "select"){
        var opts = [{ value:"", label:c.filter.placeholder||"全部" }].concat(c.filter.options||[]);
        var sel = selectBox(opts, { value:filters[c.key] || "" });
        sel.el.classList.add("cg-filterbar__control");
        sel.addEventListener("change", function(){ filters[c.key] = sel.value; syncFilterState(); paint(); });
        item.appendChild(sel.el);
        filterResets.push(function(){ sel.value = ""; });
      } else {
        /* 文本筛选带一个清除叉：不用把框里的字全删掉再点别处 */
        var field = h("div",{class:"cg-filterbar__field"});
        var inp = h("input",{class:"el-input__inner cg-filterbar__control",placeholder:c.filter.placeholder||"筛选"});
        inp.value = filters[c.key] || "";
        var clr = h("button",{class:"cg-filterbar__clear",type:"button",title:"清除「"+c.label+"」的筛选",text:"\u2715"});
        function syncClr(){ field.classList.toggle("has-value", !!inp.value); }
        inp.addEventListener("input", function(){ filters[c.key] = inp.value; syncClr(); syncFilterState(); repaintRows(); });
        clr.addEventListener("click", function(){ inp.value = ""; delete filters[c.key]; syncClr(); syncFilterState(); repaintRows(); });
        syncClr();
        field.appendChild(inp); field.appendChild(clr);
        item.appendChild(field);
        filterResets.push(function(){ inp.value = ""; delete filters[c.key]; syncClr(); });
      }
      filterbar.appendChild(item);
    });

    var tail = h("div",{class:"cg-filterbar__tail"});
    (opt.toolbarActions || []).forEach(function(b){ tail.appendChild(b); });
    if(hasColFilters){
      tail.appendChild(h("span",{class:"cg-filterbar__count",text:""}));
      tail.appendChild(h("button",{
        class:"el-button el-button--small el-button--text",
        text:"清除筛选",
        onclick:function(){
          filters = {};
          filterResets.forEach(function(fn){ fn(); });
          syncFilterState();
          paint();
        }
      }));
    }
    filterbar.appendChild(tail);
    syncFilterState();
  }

  /** 显示「已筛 N 项」，没筛就藏起来 */
  function syncFilterState(){
    var n = Object.keys(filters).filter(function(k){ return !!filters[k]; }).length;
    var box = filterbar.querySelector(".cg-filterbar__count");
    if(box) box.textContent = n ? "已筛 " + n + " 项" : "";
    filterbar.classList.toggle("is-active", n > 0);
  }
  /* 想给某张表单独定高就传 opt.maxHeight，比如 opt.maxHeight = "40vh" */
  if(opt.maxHeight) wrap.style.maxHeight = opt.maxHeight;
  var bar = h("div",{class:"cg-batchbar hidden"});
  var tbl = h("table",{class:"el-table"+(opt.striped===false?"":" el-table--striped")+(opt.dense?" el-table--dense":"")});

  function paint(){
    clear(tbl);
    var thead = h("thead");
    var trh = h("tr");

    if(opt.selectable){
      var th0 = h("th",{class:"cg-col-check"});
      var all = filterRows(rows);
      var allOn = all.length > 0 && all.every(function(r){ return selected[idOf(r)]; });
      var master = h("input",{type:"checkbox"});
      master.checked = allOn;
      master.addEventListener("change", function(){
        all.forEach(function(r){ if(master.checked) selected[idOf(r)] = true; else delete selected[idOf(r)]; });
        paint();
      });
      th0.appendChild(master);
      trh.appendChild(th0);
    }

    columns.forEach(function(c){
      var th = h("th",{class:(c.sortable?"is-sortable":"") + (state.key===c.key?" is-sorted":"") + (c.align?" is-"+c.align:"")});
      var label = h("span",{class:"cg-th__label"});
      label.appendChild(h("span",{text:c.label}));
      if(c.sortable){
        label.appendChild(h("span",{class:"caret",text: state.key===c.key ? (state.dir==="asc"?"▲":"▼") : "⇅"}));
      }
      th.appendChild(label);
      if(c.sortable){
        th.addEventListener("click", function(){
          if(state.key === c.key) state.dir = state.dir === "asc" ? "desc" : "asc";
          else { state.key = c.key; state.dir = "desc"; }
          paint();
        });
      }
      if(c.width) th.style.width = c.width;
      trh.appendChild(th);
    });

    thead.appendChild(trh);
    tbl.appendChild(thead);
    tbl.appendChild(body());
    paintBar();
  }

  /* 只重画 tbody，输入框不丢焦点 */
  function repaintRows(){
    var old = tbl.querySelector("tbody");
    if(old) tbl.replaceChild(body(), old);
    paintBar();
  }

  function body(){
    var tbody = h("tbody");
    var list = sortRows(filterRows(rows));
    if(list.length === 0){
      var td = h("td",{class:"el-table__empty",colspan:String(columns.length + (opt.selectable?1:0))});
      td.appendChild(emptyState(rows.length ? "没有符合筛选的行" : (opt.emptyText||"暂无数据")));
      var tre = h("tr"); tre.appendChild(td); tbody.appendChild(tre);
      return tbody;
    }
    list.forEach(function(row){
      var tr = h("tr");
      if(opt.rowClass){ var rc = opt.rowClass(row); if(rc) tr.className = rc; }
      var rid = idOf(row);
      if(opt.selectable){
        var tdc = h("td",{class:"cg-col-check"});
        var cb = h("input",{type:"checkbox"});
        cb.checked = !!selected[rid];
        cb.addEventListener("change", function(){
          if(cb.checked) selected[rid] = true; else delete selected[rid];
          tr.className = (opt.rowClass ? (opt.rowClass(row)||"") : "") + (cb.checked ? " is-selected" : "");
          paintBar();
          var head = tbl.querySelector("thead input[type=checkbox]");
          if(head){ var vis = filterRows(rows); head.checked = vis.length>0 && vis.every(function(r){ return selected[idOf(r)]; }); }
        });
        tdc.appendChild(cb);
        tr.appendChild(tdc);
      }
      columns.forEach(function(c){
        var td2 = h("td", c.align ? {class:"is-"+c.align} : null);
        var cell = h("div",{class:"cell" + (c.wrap?" wrap":"") + (c.clamp?" clamp":"")});
        var v = c.render ? c.render(row) : row[c.key];
        if(v && v.nodeType) cell.appendChild(v);
        else cell.textContent = (v===null||v===undefined||v==="") ? "-" : String(v);
        td2.appendChild(cell);
        if(c.title) td2.title = c.title(row);
        tr.appendChild(td2);
      });
      tbody.appendChild(tr);
    });
    return tbody;
  }

  function paintBar(){
    if(!opt.selectable || !opt.batchActions) return;
    var ids = selectedIds();
    clear(bar);
    if(!ids.length){ bar.className = "cg-batchbar hidden"; return; }
    bar.className = "cg-batchbar";
    bar.appendChild(h("span",{class:"cg-batchbar__n",text:"已选 " + ids.length + " 项"}));
    opt.batchActions.forEach(function(b){
      bar.appendChild(h("button",{
        class:"el-button el-button--small" + (b.type ? " el-button--" + b.type : ""),
        text:b.label,
        onclick:function(){
          Promise.resolve(b.run(ids)).then(function(){
            if(b.keep!==true) selected = {};
            paint();
          }).catch(showErr);
        }
      }));
    });
    bar.appendChild(h("button",{class:"el-button el-button--small el-button--text",text:"取消选择",onclick:function(){ selected = {}; paint(); }}));
  }

  buildFilterBar();
  paint();
  wrap.appendChild(tbl);
  var host = h("div",{class:"cg-table-host"});
  host.appendChild(bar);
  host.appendChild(filterbar);
  host.appendChild(wrap);
  host.repaint = paint;
  host.selectedIds = selectedIds;
  return host;
}
`;
