import type { Browser } from './browser.js';
import { inspectForm } from './forms.js';
import { ServiceError } from './auth.js';

// Two matching definitions around a fresh screenshot. A changing value or
// validation hint does not change the definition; real conditional fields do.
export async function observeForm(
  browser: Browser,
  jobId: string,
  secrets: string[],
  signal: AbortSignal,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    signal.throwIfAborted();
    const page = browser.page;
    if (!page || browser.ownerJobId !== jobId) throw new ServiceError('observation_target_changed');
    const before = await inspectForm(page);
    await page.waitForTimeout(150);
    const o = await browser.observe(true, secrets);
    const { view } = await inspectForm(page);
    if (browser.page !== page || browser.ownerJobId !== jobId)
      throw new ServiceError('observation_target_changed');
    if (o.url === view.url && before.view.fingerprint === view.fingerprint && !view.ui?.busy)
      return { o, view };
  }
  throw new ServiceError('form_observation_unstable');
}
