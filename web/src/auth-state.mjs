import { reactive } from 'vue';
export const authState = reactive({ ready: false, isolation: false, user: null, adminOwnerUsername: '' });
export const isIsolationAdmin = () => authState.isolation && authState.user?.role === 'admin';
export const authStorageSuffix = () => authState.isolation ? `.user.${authState.user?.username || 'anonymous'}` : '';
