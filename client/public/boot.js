/**
 * 首屏防闪烁：在页面首次绘制之前同步执行（必须是普通脚本，放在 <head> 里）。
 * 本地有保存的登录口令时，给 <html> 加上 has-token，CSS 据此隐藏登录页、显示加载占位，
 * 等 main.js 验证通过后再显示主界面；口令失效则由 main.js 去掉该标记并显示登录页。
 * 同时清理同域名下可能残留的旧 Service Worker（如 sw.js），避免拦截接口请求或报 clone 错误。
 */
(function () {
  try {
    if (localStorage.getItem('cfhub-token') || sessionStorage.getItem('cfhub-token')) {
      document.documentElement.classList.add('has-token');
    }
  } catch (e) { /* 隐私模式下读取存储可能抛错：按未登录处理 */ }
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        for (var i = 0; i < regs.length; i++) regs[i].unregister();
      }).catch(function () {});
    }
  } catch (e) { /* 忽略不支持的环境 */ }
})();
