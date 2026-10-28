// Exercise the platform entry point instead of dispatching internal events.
export async function openGlobalSettings(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.sidebar-actions-trigger,.mobile-nav-menu > summary')].some(el => el.getBoundingClientRect().width > 0))
  const native = page.locator('neo-window-chrome [data-settings-action]')
  if (await native.isVisible()) { await native.click(); return }
  if (await page.locator('.sidebar-actions-trigger').isVisible()) {
    const menu = page.locator('.sidebar-actions-menu')
    if (!await menu.isVisible()) await page.locator('.sidebar-actions-trigger').click()
    await menu.getByRole('menuitem', { name: '全局配置', exact: true }).click()
    return
  }
  await page.locator('.mobile-nav-menu > summary').click()
  await page.locator('.mobile-nav-menu').getByRole('button', { name: '全局配置', exact: true }).click()
}
