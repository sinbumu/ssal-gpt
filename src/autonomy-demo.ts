import type { Store } from './store.js';
import { hash } from './autonomy.js';

type DemoState = { page: number; layout: string; inbox: boolean; posts: number };
export function demoState(store: Store, run: string): DemoState {
  return store.settings(`synthetic:${run}`, { page: 1, layout: 'normal', inbox: false, posts: 0 });
}
export function fieldName(run: string, label: string) {
  return `f_${hash([run, label]).slice(0, 12)}`;
}
export function autonomyDemo(store: Store, run: string) {
  const state = demoState(store, run);
  const receipt = store.receipt(run);
  if (receipt)
    return `<html lang="ko"><title>접수 결과</title><h1>설문이 완료되었습니다.</h1><p>접수번호: ${receipt}</p><p>합성 테스트입니다. 실제 응모가 아닙니다.</p></html>`;
  const name = (label: string) => fieldName(run, label);
  const text = (label: string, type = 'text') =>
    `<fieldset><legend>${label}</legend><label>${label}<input name="${name(label)}" type="${type}" required></label></fieldset>`;
  const choice = (label: string, options: string[], multiple = false) =>
    `<fieldset ${multiple ? 'aria-required="true"' : ''}><legend>${label}</legend>${options.map((o, i) => `<label class="choice"><input type="${multiple ? 'checkbox' : 'radio'}" name="${name(label)}" value="${i}" ${multiple ? '' : 'required'}><span>${o}</span></label>`).join('')}</fieldset>`;
  const ratings = ['매우 그렇다', '그렇다', '그런 편이다', '보통이다', '그렇지 않다'];
  const preference = '선호하는 경품은? (최대 3개, 우선순위대로)';
  let fields = '';
  if (state.page === 1) fields = text('이름') + text('이메일', 'email');
  if (state.page === 2)
    fields =
      choice(preference, ['커피', '차', '음료']) +
      choice('문화 정보를 얻는 곳', ['포털 검색', 'SNS', '뉴스'], true) +
      `<div id="conditional"></div><script>document.querySelector('[name="${name(preference)}"]').addEventListener('change',()=>{if(!document.querySelector('#conditional').children.length)document.querySelector('#conditional').innerHTML=${JSON.stringify(choice('화면의 선택지가 이해하기 쉽다', ratings))}});</script>`;
  if (state.page === 3)
    fields = ['메뉴가 명확하다', '디자인이 적절하다', '정보 검색이 편리하다', '색상이 편안하다']
      .map((q) => choice(q, ratings))
      .join('');
  if (state.page === 4)
    fields =
      choice(preference, ['커피', '차', '음료']) +
      (state.inbox
        ? choice('이 사이트를 이용한 경험이 있나요?', ['예', '아니요']) +
          choice('회원인가요?', ['예', '아니요'])
        : choice('메뉴가 명확하다', ratings));
  if (state.page === 5)
    fields =
      text('전화번호', 'tel') +
      '<fieldset><legend>선택 마케팅 동의</legend><label><input type="checkbox" name="marketing" value="yes">마케팅 메시지 수신</label></fieldset>';
  return `<!doctype html><html lang="ko"><head><title>자율화 합성 설문</title><style>body{font:18px sans-serif;background:#f5f3eb;color:#15251e;max-width:900px;margin:40px auto}fieldset{margin:24px 0;padding:24px;border:1px solid #aab7ad}legend{font-weight:bold}.choice{display:inline-flex;position:relative;margin:10px;padding:16px;background:white;cursor:pointer}.choice input{position:absolute;inset:0;opacity:0;width:100%;height:100%}.choice span{position:relative;pointer-events:none}.choice:has(:checked){background:#cdebd0}input{font-size:20px;padding:10px}button{font-size:22px;padding:16px 32px} ${state.layout === 'shift' ? 'fieldset:nth-of-type(2){margin-top:350px}.choice{display:flex}' : ''}</style></head><body><h1>자율화 합성 설문</h1><p>${state.page} / 5 페이지</p><p>실제 응모·개인정보 전송이 없는 테스트입니다.</p><form method="post" action="/demo/autonomy?run=${run}">${fields}<button type="submit">${state.page < 5 ? '다음' : '제출'}</button></form></body></html>`;
}
export function acceptDemo(store: Store, run: string, params: URLSearchParams) {
  const state = demoState(store, run);
  if (store.receipt(run)) return false;
  const value = (label: string) => params.get(fieldName(run, label));
  const pref = '선호하는 경품은? (최대 3개, 우선순위대로)';
  if (
    state.page === 1 &&
    (value('이름') !== '테스트 참가자' || value('이메일') !== 'demo@example.invalid')
  )
    return false;
  if (
    state.page === 2 &&
    (value(pref) !== '0' ||
      !value('문화 정보를 얻는 곳') ||
      !value('화면의 선택지가 이해하기 쉽다'))
  )
    return false;
  if (
    state.page === 3 &&
    ['메뉴가 명확하다', '디자인이 적절하다', '정보 검색이 편리하다', '색상이 편안하다'].some(
      (q) => value(q) === null,
    )
  )
    return false;
  if (
    state.page === 4 &&
    (value(pref) !== '0' ||
      (state.inbox &&
        (value('이 사이트를 이용한 경험이 있나요?') === null || value('회원인가요?') === null)))
  )
    return false;
  if (state.page === 5 && (value('전화번호') !== '010-0000-0000' || params.has('marketing')))
    return false;
  state.posts++;
  state.page++;
  store.setSettings(`synthetic:${run}`, state);
  if (state.page > 5) store.submitDemo(run);
  return true;
}
