import type { Store } from './store.js';
export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export function demoPage(url: URL, store: Store) {
  const run = url.searchParams.get('run') || 'sample';
  const receipt = store.receipt(run);
  const shifted = url.searchParams.get('layout') === 'shift';
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>쌀-GPT 합성 이벤트</title>
  <style>body{font:18px system-ui;background:#faf6ed;color:#203c34;margin:0}main{max-width:740px;margin:auto;padding:45px}section{padding:28px;border:1px solid #c6d1bf;border-radius:24px;background:white;margin:20px 0}button{padding:14px 24px;background:#256452;color:white;border:0;border-radius:12px;font-size:18px;cursor:pointer}label{display:block;margin:20px 0}textarea,input{font:inherit}textarea{width:90%;height:90px;padding:12px}#modal{position:fixed;inset:0;background:#0008;display:grid;place-items:center;z-index:3}#modal section{max-width:450px}small{color:#777}</style>
  <main><small>합성 테스트 · 실제 경품과 무관합니다</small><h1>봄날의 커피 한 잔</h1><p>화면을 읽고 참여하는 브라우저 에이전트 테스트입니다.</p>
  ${
    receipt
      ? `<section><h2>응모가 완료되었습니다</h2><p>접수번호: ${escapeHtml(receipt)}</p><p>같은 테스트 실행은 한 번만 접수됩니다.</p></section>`
      : `
  <section style="margin-bottom:${shifted ? 680 : 540}px"><h2>이벤트 안내</h2><p>아래 조건을 읽고 퀴즈와 한 줄 응원으로 참여하세요.</p><p>실제 개인정보를 입력하지 마세요.</p></section>
  <section><h2>참여 조건</h2><p>테스트 마감: 2099년 12월 31일 23:59 (한국 시간)</p><p>경품: 가상 커피 쿠폰 100명. 실제 상품이 지급되지 않습니다.</p><p>퀴즈: 이 테스트에서 경품으로 안내한 음료는 무엇인가요?</p>
  <form method="post" action="/demo/submit?run=${encodeURIComponent(run)}">
  ${shifted ? '<label><input type="radio" name="answer" value="tea" required> 차</label>' : ''}
  <label><input type="radio" name="answer" value="coffee" required> 커피</label>
  ${!shifted ? '<label><input type="radio" name="answer" value="tea" required> 차</label>' : ''}
  <label>응원 한 줄 (5자 이상)<textarea name="comment" required minlength="5" maxlength="200" placeholder="응원 한 줄을 적어주세요"></textarea></label>
  <label><input type="checkbox" name="required" required> 필수: 합성 테스트 데이터 접수에 동의합니다</label>
  <label><input type="checkbox" name="marketing"> 선택: 홍보 알림 받기 (동의 불필요)</label>
  <button type="submit">응모 제출</button></form></section>`
  }</main>
  ${receipt ? '' : `<div id="modal"><section><h2>테스트 안내</h2><p>가상의 이벤트입니다. 창을 닫고 아래 참여 조건을 확인하세요.</p><button type="button" onclick="document.getElementById('modal').remove()">닫기</button></section></div>`}</html>`;
}
