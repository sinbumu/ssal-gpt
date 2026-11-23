import type { Page, ElementHandle } from 'playwright';
import { ServiceError } from './auth.js';
import { statisticsPage } from './statistics-query.js';

// Group a dependent region picker into one query, verifying each newly rendered
// list. Values are never translated to hidden region codes or sent to an API.
export async function selectStatisticsRegion(
  page: Page,
  target: ElementHandle<HTMLElement>,
  text: string,
) {
  const names = text.split('>').map((s) => s.trim());
  if (
    !names.length ||
    names.length > 3 ||
    names.some((s) => !s || s.length > 40 || !/^[가-힣\d·\s()]+$/.test(s))
  )
    throw new ServiceError('statistics_region_invalid');
  const url = page.url();
  const house = await target.evaluate((el) => el.matches('#housingLayer .area-select-wrap'));
  const industry = await target.evaluate((el) => el.matches('.location_wrap .addr_wrap'));
  if (house && names.length > 2) throw new ServiceError('statistics_region_invalid');
  const assertScope = () => {
    if (page.url() !== url || !statisticsPage(url)) throw new ServiceError('stale_observation');
  };
  if (
    industry &&
    !(await page
      .locator('.location_wrap .addres_wrap .area01 li')
      .filter({ visible: true })
      .count())
  )
    await target.click();
  if (
    !house &&
    !industry &&
    !(await page.locator('ul[id^=sidoSelect_] li').filter({ visible: true }).count())
  )
    await target.click();
  for (let i = 0; i < names.length; i++) {
    assertScope();
    const selector = industry
      ? `.location_wrap .addres_wrap .area0${i + 1}`
      : house
        ? `#housingLayer .area-select.${i === 0 ? 'sido' : 'sgg'}`
        : `ul[id^=${['sidoSelect_', 'sggSelect_', 'admSelect_'][i]}]`;
    if (
      house &&
      !(await page
        .locator(selector + ' li')
        .filter({ visible: true })
        .count())
    )
      await page.locator(selector).filter({ visible: true }).click();
    const options = page.locator(selector + ' li').filter({ visible: true });
    const option = options.filter({
      hasText: new RegExp('^\\s*' + names[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'),
    });
    await option.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
      throw new ServiceError('statistics_option_not_observed');
    });
    if ((await option.count()) !== 1) throw new ServiceError('statistics_option_not_observed');
    await option.click();
    await page.waitForTimeout(250);
    assertScope();
  }
  if (!house) {
    const confirm = page
      .locator(industry ? '.location_wrap #address_ok_btn' : '.navi-action #navi-confirm')
      .filter({ visible: true });
    if ((await confirm.count()) !== 1) throw new ServiceError('statistics_region_unverified');
    await confirm.click();
  }
  await page.waitForTimeout(250);
  assertScope();
  // Selection updates after the map finishes its asynchronous region lookup.
  // Poll rendered selection only; never repeat clicks on a slow response.
  for (let attempt = 0; attempt < 25; attempt++) {
    assertScope();
    const selected = house
      ? await target.evaluate((el) =>
          [...el.querySelectorAll('.placeholder')].map((e) => e.textContent || '').join(' '),
        )
      : await target.innerText();
    if (names.every((n) => selected.replace(/\s/g, '').includes(n.replace(/\s/g, '')))) return;
    await page.waitForTimeout(200);
  }
  throw new ServiceError('statistics_region_unverified');
}
