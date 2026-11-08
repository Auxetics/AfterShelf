// The guard evaluates before the real entry point. Never import the app here
// without the parent's generated profile, which contains only loopback sources.
import './fixtures/require-isolated-profile.mjs';
import '../app/main.mjs';
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';

app.on('browser-window-created', (_event, window) => window.on('show', () => window.hide()));
const watchdog = setTimeout(() => { console.error('Actual main-source fixture timed out.'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  try {
    let window;
    for (let n = 0; n < 200; n++) {
      window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/app/ui/index.html'));
      if (window) break; await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(window, 'actual main process should open the isolated application');
    const evaluate = script => window.webContents.executeJavaScript(script, true);
    async function until(script) {
      for (let n = 0; n < 400; n++) { if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw new Error('Actual main-source UI timed out: ' + script + '; ' + await evaluate("document.querySelector('#toast').textContent"));
    }
    await until("document.querySelectorAll('.game-card').length===2");
    await evaluate("document.querySelector('[data-nav=settings]').click()");
    await until("document.querySelectorAll('[data-source-form]').length===2");
    for (const id of ['f95', 'lc']) {
      await evaluate(`document.querySelector('[data-source-form=${id}] [data-action=check-source]').click()`);
      await until(`document.querySelector('[data-source-health=${id}]').textContent.includes('listing parsed')`);
    }
    await evaluate("document.querySelector('[data-nav=library]').click()");
    await until("Boolean(document.querySelector('#content [data-action=check-updates]'))");
    await evaluate("document.querySelector('#content [data-action=check-updates]').click()");
    await until("!document.querySelector('#content [data-action=check-updates]').disabled && document.querySelector('#toast').textContent.includes('Checked game sources')");
    const repeated = await evaluate("window.library.call('check-updates')");
    assert.equal(repeated.ok, true); assert.equal(repeated.value.verified, 0); assert.equal(repeated.value.mode, 'feed');
    await evaluate("document.querySelector('#content [data-action=open-source][data-source=lc]').click()");
    await until("Boolean(document.querySelector('.browser-tab.active')) && document.querySelector('.browser-tab.active').textContent.includes('LC Fixture Forum')");
    await evaluate("document.querySelector('.browser-toolbar [data-action=open-source][data-source=f95]').click()");
    await until("document.querySelectorAll('.browser-tab').length===2 && document.querySelector('.browser-tab.active').textContent.includes('F95 Fixture Forum')");
    clearTimeout(watchdog); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(watchdog); app.exit(1); }
});
