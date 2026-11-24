import { ref } from 'vue';

export const toasts = ref<{ id: number; msg: string }[]>([]);
let nextId = 0;

export function toast(msg: string) {
  const id = ++nextId;
  toasts.value = [...toasts.value, { id, msg }];
  setTimeout(() => {
    toasts.value = toasts.value.filter(item => item.id !== id);
  }, 3600);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    toast('浏览器未授权复制，请选中文本手动复制');
  }
}
