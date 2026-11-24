import { computed, ref } from 'vue';

export type ChoiceOption = { id: string; name: string; desc?: string };

type Pending = {
  kind: 'confirm' | 'input' | 'choice' | 'alert';
  title: string;
  message: string;
  details: string[];
  okText: string;
  cancelText: string;
  danger: boolean;
  defaultValue: string;
  placeholder: string;
  multiline: boolean;
  options: ChoiceOption[];
  selected: string;
  resolve: (value: unknown) => void;
};

const stack = ref<Pending[]>([]);
export const pendingDialog = computed(() => stack.value.at(-1) ?? null);

function push(partial: Partial<Pending> & Pick<Pending, 'kind' | 'resolve'>) {
  stack.value = [...stack.value, {
    title: '请确认',
    message: '',
    details: [],
    okText: '确定',
    cancelText: '取消',
    danger: false,
    defaultValue: '',
    placeholder: '',
    multiline: false,
    options: [],
    selected: '',
    ...partial,
  }];
}

export function settleDialog(value: unknown) {
  const current = stack.value.at(-1);
  stack.value = stack.value.slice(0, -1);
  current?.resolve(value);
}

export function askConfirm(opts: Partial<Omit<Pending, 'kind' | 'resolve'>> = {}) {
  return new Promise<boolean>(resolve => push({ ...opts, kind: 'confirm', resolve: value => resolve(value === true) }));
}

export function askInput(opts: Partial<Omit<Pending, 'kind' | 'resolve'>> = {}) {
  return new Promise<string | null>(resolve => push({
    ...opts,
    kind: 'input',
    title: opts.title || '请输入',
    resolve: value => resolve(typeof value === 'string' ? value : null),
  }));
}

export function askChoice(opts: { title?: string; message?: string; options: ChoiceOption[]; selected?: string; okText?: string }) {
  return new Promise<string | null>(resolve => push({
    kind: 'choice',
    title: opts.title || '请选择',
    message: opts.message || '',
    options: opts.options,
    selected: opts.selected || opts.options[0]?.id || '',
    okText: opts.okText || '确定',
    resolve: value => resolve(typeof value === 'string' ? value : null),
  }));
}

export function showAlert(title: string, message: string, details: string[] = []) {
  return new Promise<void>(resolve => push({
    kind: 'alert',
    title,
    message,
    details,
    okText: '知道了',
    resolve: () => resolve(),
  }));
}
