<script setup>
import { defineAsyncComponent, onMounted, onBeforeUnmount, ref } from 'vue';
import { appFetch } from './app-url.mjs';
import { authState } from './auth-state.mjs';

const App = defineAsyncComponent(() => import('./App.vue'));
const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);
const passwordVisible = ref(false);

async function refresh() {
  error.value = '';
  try {
    const response = await appFetch('/api/auth/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取登录状态');
    const value = await response.json();
    if (typeof value.isolation !== 'boolean') throw new Error('登录状态无效');
    Object.assign(authState, value, { ready: true });
  } catch (e) { error.value = e.message; }
}

async function login() {
  if (busy.value) return;
  if (!username.value || !password.value) {
    error.value = '请输入用户名和密码';
    document.getElementById(!username.value ? 'auth-username' : 'auth-password')?.focus();
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const response = await appFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '登录失败');
    password.value = '';
    location.reload();
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}

const expired = () => { authState.user = null; password.value = ''; };
let poll;
onMounted(async () => {
  window.addEventListener('neo-auth-required', expired);
  await refresh();
  poll = setInterval(() => { if (authState.isolation && authState.user) void refresh(); }, 30000);
});
onBeforeUnmount(() => {
  clearInterval(poll);
  window.removeEventListener('neo-auth-required', expired);
});
</script>

<template>
  <App v-if="authState.ready && (!authState.isolation || authState.user)" :key="authState.user?.username || 'local'" />
  <main v-else class="auth-screen" aria-label="用户登录">
    <div class="motion-field" aria-hidden="true">
      <i class="flow flow-a"></i><i class="flow flow-b"></i>
    </div>
    <form class="auth-card" :class="{ shaking: error }" aria-label="用户登录" :aria-busy="busy" novalidate @submit.prevent="login">
      <template v-if="authState.ready">
        <div class="auth-fields">
          <div class="icon-field">
            <input id="auth-username" v-model="username" aria-label="用户名" name="username" autocomplete="username" autocapitalize="none" :spellcheck="false" maxlength="100" enterkeyhint="next" required :aria-invalid="!!error" :aria-describedby="error ? 'auth-error' : undefined" />
            <svg class="field-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-4 2.5-6 7-6s7 2 7 6" /></svg>
            <i class="field-line" aria-hidden="true"></i>
          </div>
          <div class="icon-field">
            <input id="auth-password" v-model="password" aria-label="密码" name="password" :type="passwordVisible ? 'text' : 'password'" autocomplete="current-password" enterkeyhint="go" required :aria-invalid="!!error" :aria-describedby="error ? 'auth-error' : undefined" />
            <svg class="field-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>
            <i class="field-line" aria-hidden="true"></i>
            <button class="password-toggle" type="button" :aria-label="passwordVisible ? '隐藏密码' : '显示密码'" :aria-pressed="passwordVisible" @click="passwordVisible = !passwordVisible">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="3" /><path v-if="passwordVisible" d="m3 3 18 18" /></svg>
            </button>
          </div>
        </div>
        <div class="auth-actions">
          <div class="status-slot">
            <div v-if="error" id="auth-error" class="auth-error" role="alert">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3h.01" /></svg>
              <span class="sr-only">{{ error }}</span>
            </div>
          </div>
          <button class="submit-button" type="submit" :aria-label="busy ? '正在验证' : '登录'" :disabled="busy">
            <i v-if="busy" class="spinner" aria-hidden="true"></i>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
          </button>
        </div>
      </template>
      <div v-else class="connecting" role="status" aria-label="正在连接服务">
        <button v-if="error" class="retry-button" type="button" aria-label="重试" @click="refresh"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 6" /></svg></button>
        <i v-else class="spinner" aria-hidden="true"></i>
        <span v-if="error" class="sr-only" role="alert">{{ error }}</span>
      </div>
    </form>
  </main>
</template>

<style scoped>
/* Local overrides keep the login independent of the application's global skin. */
.auth-screen {
  color-scheme: dark;
  --text: #f7f7fb;
  --line: #52617a;
  height: 100vh;
  height: 100dvh;
  overflow: auto;
  display: flex;
  padding: max(24px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
  isolation: isolate;
  position: relative;
  color: #f7f7fb;
  background: radial-gradient(ellipse at 50% 80%, #172334, #080c14 70%) !important;
}
.auth-screen svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.65; stroke-linecap: round; stroke-linejoin: round; }
.motion-field { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
.flow { position: absolute; left: 50%; top: 50%; width: min(900px, 130vw); height: 360px; border-radius: 50% !important; filter: blur(50px); opacity: .42; }
.flow-a { background: conic-gradient(transparent, #36849a, transparent 40%, #b14e91, transparent 75%) !important; animation: current-a 8s ease-in-out infinite alternate; }
.flow-b { background: conic-gradient(from 160deg, transparent, #3d578e, transparent 60%) !important; animation: current-b 11s ease-in-out infinite alternate; }
.auth-card { width: min(380px, 100%); flex: 0 0 auto; margin: auto; padding: 30px; position: relative; border: 1px solid #8ca3b530; border-radius: 0 !important; background: linear-gradient(150deg, rgba(26,34,46,.58), rgba(16,22,32,.48) 74%) !important; backdrop-filter: blur(8px) !important; -webkit-backdrop-filter: blur(8px) !important; box-shadow: 0 24px 70px #0005, inset 0 1px #ffffff0c; animation: arrive .65s cubic-bezier(.16,1,.3,1); }
.auth-fields { display: grid; gap: 16px; }
.icon-field { position: relative; height: 62px; }
.auth-screen .auth-card .icon-field input { width: 100%; height: 100%; padding: 0 54px 0 52px; border: 1px solid #52617a !important; border-radius: 0 !important; background: #101420 !important; color: #f7f7fb !important; caret-color: #9ee8f8; font-family: inherit !important; font-size: 16px; outline: none; box-shadow: none !important; }
.field-icon { position: absolute; left: 17px; top: 20px; pointer-events: none; color: #abbfd2; transition: color .25s, transform .3s; }
.field-line { position: absolute; left: 18px; right: 18px; bottom: 0; height: 2px; background: linear-gradient(90deg, #e995c4, #9ce8f5) !important; transform: scaleX(0); transition: transform .35s cubic-bezier(.2,.8,.2,1); }
.auth-screen .auth-card .icon-field input:focus { border-color: #92dce8 !important; box-shadow: 0 0 0 3px #92dce817 !important; }
.icon-field:focus-within .field-icon { color: #c8f7ff; transform: translateY(-2px); }
.icon-field:focus-within .field-line { transform: scaleX(1); }
.password-toggle, .retry-button { display: grid; place-items: center; width: 44px; height: 44px; border: 0; padding: 0; border-radius: 0 !important; background: transparent !important; color: #abbfd2; }
.password-toggle { position: absolute; right: 7px; top: 9px; }
.password-toggle svg { width: 19px; height: 19px; }
.password-toggle:hover { color: #f7f7fb; }
.auth-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 24px; }
.status-slot { display: grid; place-items: center; width: 32px; height: 32px; }
.auth-error { display: grid; place-items: center; color: #ffb1c5; }
.submit-button { width: 52px; height: 44px; padding: 0; display: grid; place-items: center; position: relative; overflow: hidden; border: 1px solid #9ecdd340; border-radius: 0 !important; background: linear-gradient(115deg, #c5f0f4, #c3c1ed) !important; color: #152532; box-shadow: 0 6px 24px #8dd0e51c; }
.submit-button::before { content: ''; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 20%, #ffffff90, transparent 75%) !important; transform: translateX(-150%); animation: sweep 3.5s ease-in-out infinite; }
.submit-button svg { position: relative; width: 20px; height: 20px; transition: transform .3s; }
.submit-button:hover:not(:disabled) svg { transform: translateX(5px); }
.auth-screen button:focus-visible { outline: 2px solid #b7efff !important; outline-offset: 4px; }
.auth-screen .submit-button:disabled { opacity: .8 !important; cursor: wait !important; }
.connecting { min-height: 130px; display: grid; place-content: center; justify-items: center; }
.spinner { display: block; width: 22px; height: 22px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50% !important; animation: orbit .7s linear infinite; }
.shaking { animation: reject .4s ease; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.auth-screen .auth-card input:autofill { -webkit-text-fill-color: #f7f7fb !important; box-shadow: inset 0 0 0 100px #101420 !important; }
.auth-screen ::selection { color: #fff; background: #754391 !important; }
@keyframes arrive { from { opacity: 0; transform: translateY(28px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes orbit { to { transform: rotate(360deg); } }
@keyframes current-a { from { transform: translate(-65%, -55%) rotate(-22deg); } to { transform: translate(-35%, -40%) rotate(30deg); } }
@keyframes current-b { from { transform: translate(-40%, -40%) rotate(30deg); } to { transform: translate(-70%, -65%) rotate(-30deg); } }
@keyframes sweep { 0%, 60% { transform: translateX(-150%); } 100% { transform: translateX(150%); } }
@keyframes reject { 20%, 60% { transform: translateX(-6px); } 40%, 80% { transform: translateX(6px); } }
@media (max-width: 600px) { .auth-card { padding: 32px 22px 24px; border-radius: 0 !important; } .flow { height: 260px; filter: blur(32px); } }
@media (max-height: 550px) { .auth-card { padding-top: 24px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
