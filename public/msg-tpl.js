'use strict';
/**
 * 消息模板编辑区（v4.21.0 需求 1）—— 技术债 W-7 的第一刀切片
 *
 * 为什么单独成文件：`app.js` 已经一万多行，任何改动都要在巨型文件里找位置。
 * 这一块「按板块渲染模板卡片 + 保存 + 恢复默认」边界很干净（只用到数据、请求、
 * 提示、以及 #modal-layer 这一个容器），正好拿来做一次**可控切片**：
 *   · 不做全局重构，不动 DATA_SIG / 事件委托 / 渲染流程，风险面只有一个弹窗；
 *   · 依赖用「传进来」的方式（下面的 deps），不靠在 app.js 的闭包里偷看变量，
 *     这样它天生就是可测试、可再拆的独立单元。
 *
 * ★ 必须由 index.html 在 app.js **之前**加载（CSP 只允许外链脚本，
 *   内联 <script> 会被 script-src 'self' 静默拒绝 —— 本项目踩过一次）。
 */
(function () {
  /**
   * @param {object} deps
   * @param {(s:any)=>string} deps.esc        HTML 转义（与 app.js 同一个实现，避免两套转义规则）
   * @param {(p:string,o?:object)=>Promise<any>} deps.api  请求封装
   * @param {(msg:string,kind?:string)=>void} deps.toast   提示
   * @param {()=>object|null} deps.getTemplates  取当前 state.settings.msgTemplates
   * @param {(settings:object)=>void} deps.setSettings 回写 state.settings
   */
  window.MsgTplUI = function (deps) {
    const d = deps || {};
    const esc = d.esc || ((s) => String(s == null ? '' : s));
    const cardSel = (key) => `#modal-layer [data-tpl-card="${key}"]`;

    /** 某个板块下的模板（remind / notify / bill） */
    function list(group) {
      const all = d.getTemplates();
      if (!all) return [];
      /* v4.28.11 需求 6：「记录本提醒」模板从界面下线 ——
         记录本的提醒文案与待办提醒是同一套语气，留着两个可编辑模板只会让人
         不知道该改哪个。服务端定义仍在（reminders.js 还在用），只是这里不展示。
         ★ 用户已经自定义过的那份也一并隐藏，不删库里的值：真需要时把它加回这个过滤条件即可。 */
      const HIDDEN = ['record_remind'];
      return Object.keys(all).map((k) => all[k])
        .filter((t) => t && t.group === group && !HIDDEN.includes(t.key));
    }

    function cardHtml(t) {
      return `
        <div class="tpl-card" data-tpl-card="${esc(t.key)}">
          <div class="tpl-head">
            <b>${esc(t.name)}</b>
            <span class="tpl-tag${t.custom ? ' on' : ''}">${t.custom ? '已自定义' : '系统默认'}</span>
            <button type="button" class="btn-ghost btn-sm" data-act="msg-tpl-reset"
                    data-key="${esc(t.key)}">恢复默认</button>
          </div>
          <!-- v4.28.11 需求 6：删掉模板下方那行 desc（「待办到点时发出的提醒（邮件正文与企业微信消息同一份内容）」）。
               卡片标题「待办提醒」+ 两个输入框已经说清楚这是在改什么。 -->
          <label class="field fld"><input class="fld-inp" type="text" data-tpl="subject" data-key="${esc(t.key)}"
                 maxlength="120" value="${esc(t.subject)}" placeholder="标题"><span class="flab">标题</span></label>
          <label class="field fld"><textarea class="fld-inp" data-tpl="body" data-key="${esc(t.key)}" rows="8"
                 data-min-h="0" autocomplete="off" placeholder="正文">${esc(t.body)}</textarea><span class="flab">正文</span></label>
          <!-- v4.28.11（图 10）：变量说明从「一排 code + 一段解释」改成「只有 code，
               解释挂在 title 里」—— 原来那句「{{提前提醒}}「提醒：提前 N 天（…）」整行，
               没开提前提醒时为空」在手机上会折成三行灰字，比模板本身还长。
               变量名本身已经说明白了，要细节就悬停（移动端长按）看。 -->
          <div class="tpl-vars">可用变量
            ${t.vars.map((v) => `<code title="${esc(v.desc)}">{{${esc(v.key)}}}</code>`).join('')}
          </div>
          <div class="status-ops">
            <button type="button" class="btn-soft btn-sm" data-act="msg-tpl-save"
                    data-key="${esc(t.key)}">保存这条模板</button>
            <span class="status-hint">整行的变量都为空时，这一行不会出现在消息里</span>
          </div>
        </div>`;
    }

    /** 整个板块的「消息模板」小节（没有模板时返回空串，弹窗里不会出现孤零零的标题） */
    function block(group) {
      const items = list(group);
      if (!items.length) return '';
      return `
        <div class="sub-head">消息模板</div>
        ${items.map(cardHtml).join('')}`;
    }

    /** 把服务端最新模板回填到正在编辑的卡片（不重开弹窗，别的输入不丢） */
    function paint(key) {
      const all = d.getTemplates() || {};
      const t = all[key];
      if (!t) return;
      const card = document.querySelector(cardSel(key));
      if (!card) return;
      const si = card.querySelector('[data-tpl="subject"]');
      const bi = card.querySelector('[data-tpl="body"]');
      if (si) si.value = t.subject;
      if (bi) bi.value = t.body;
      const tag = card.querySelector('.tpl-tag');
      if (tag) {
        tag.textContent = t.custom ? '已自定义' : '系统默认';
        tag.classList.toggle('on', !!t.custom);
      }
    }

    async function save(key) {
      const card = document.querySelector(cardSel(key));
      if (!card) return;
      const subject = (card.querySelector('[data-tpl="subject"]') || {}).value || '';
      const body = (card.querySelector('[data-tpl="body"]') || {}).value || '';
      try {
        const out = await d.api('/api/settings', {
          method: 'POST',
          body: { msgTemplates: { [key]: { subject, body } } },
        });
        d.setSettings(out.settings);
        paint(key);
        d.toast('模板已保存，全家生效', 'ok');
      } catch (err) {
        d.toast((err && err.message) || '模板保存失败', 'err');
      }
    }

    async function reset(key) {
      try {
        const out = await d.api('/api/settings', { method: 'POST', body: { msgTemplateReset: key } });
        d.setSettings(out.settings);
        paint(key);
        d.toast('已恢复系统默认模板', 'ok');
      } catch (err) {
        d.toast((err && err.message) || '恢复失败', 'err');
      }
    }

    return { list, cardHtml, block, paint, save, reset };
  };
})();
