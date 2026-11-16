/**
 * 首屏防闪烁：在页面首次绘制之前同步执行（必须是普通脚本，放在 <head> 里）。
 * 本地有保存的登录口令时，给 <html> 加上 has-token，CSS 据此隐藏登录页、显示加载占位，
 * 等 main.js 验证通过后再显示主界面；口令失效则由 main.js 去掉该标记并显示登录页。
 */
(function () {
  try {
    if (localStorage.getItem('cfhub-token') || sessionStorage.getItem('cfhub-token')) {
      document.documentElement.classList.add('has-token');
    }
  } catch (e) { /* 隐私模式下读取存储可能抛错：按未登录处理 */ }
})();
