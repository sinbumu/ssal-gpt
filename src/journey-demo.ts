import type { Store, Job } from './store.js';
import type { EntryTask } from './tasks.js';
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
type Demo = { likes: number; follows: number; comments: string[]; submissions: number };
export const journeyState = (store: Store, run: string) =>
  store.settings<Demo>(`journey:${run}`, { likes: 0, follows: 0, comments: [], submissions: 0 });
export function journeyTasks(origin: string, run: string): EntryTask[] {
  return (['like', 'follow', 'comment', 'form'] as const).map((kind, i) => ({
    id: `task-${i}`,
    kind,
    url: `${origin}/demo/journey/${kind === 'form' ? 'form' : 'social'}?run=${run}`,
    instruction: {
      like: '합성 게시물 좋아요',
      follow: '합성 주최자 팔로우',
      comment: '합성 참여 댓글 게시',
      form: '가상 프로필·순위·선택 파일로 합성 응모',
    }[kind],
    quote: '실제 경품이 없는 합성 과제',
    dependsOn: i ? [`task-${i - 1}`] : [],
    draft: kind === 'comment' ? '합성 이벤트 참여 테스트입니다.' : undefined,
    state: 'pending',
  }));
}
export function acceptJourney(store: Store, job: Job, stage: string, input: URLSearchParams) {
  if (!job.autonomy?.synthetic) return false;
  const s = journeyState(store, job.id);
  if (stage === 'social') {
    if (input.get('action') === 'like' && !s.likes) s.likes++;
    else if (input.get('action') === 'follow' && !s.follows) s.follows++;
    else if (input.get('action') === 'comment' && input.get('text') && !s.comments.length)
      s.comments.push(input.get('text')!);
    else return false;
  } else if (stage === 'form') {
    if (
      s.submissions ||
      !s.likes ||
      !s.follows ||
      s.comments.length !== 1 ||
      input.get('name') !== '테스트 참가자' ||
      input.get('rank') !== '커피,차,쿠폰' ||
      !input.get('file')?.endsWith('.png')
    )
      return false;
    s.submissions++;
    store.submitDemo(job.id);
  } else return false;
  store.setSettings(`journey:${job.id}`, s);
  return true;
}
export function journeyPage(store: Store, run: string, stage: string) {
  const s = journeyState(store, run),
    base = `/demo/journey/${stage}?run=${encodeURIComponent(run)}`;
  const shell = (body: string) =>
    `<!doctype html><meta charset="utf-8"><title>쌀-GPT 혼합 과제 합성 테스트</title><style>body{font:18px system-ui;max-width:780px;margin:40px auto;background:#faf8f2}button,input{font:inherit;padding:12px;margin:10px}fieldset{margin:20px 0;padding:20px}li{padding:14px;margin:8px;background:#e2eedf;cursor:grab}[role=dialog]{position:fixed;inset:10%;padding:30px;background:white;border:3px solid #245b3e}</style><h1>실제 경품이 없는 합성 과제</h1>${body}`;
  if (stage === 'social')
    return shell(
      `<button id="like" aria-pressed="${!!s.likes}">${s.likes ? '좋아요 취소' : '좋아요'}</button><button id="follow">${s.follows ? '팔로잉' : '팔로우'}</button><label>댓글<textarea id="comment"></textarea></label><button id="post">게시</button><article>${s.comments.map(escape).join('<br>')}</article><script>async function send(action,text){const r=await fetch('${base}',{method:'POST',body:new URLSearchParams({action,text:text||''})});if(r.ok)location.reload()}document.querySelector('#like').onclick=()=>send('like');document.querySelector('#follow').onclick=()=>send('follow');document.querySelector('#post').onclick=()=>send('comment',document.querySelector('#comment').value)</script>`,
    );
  if (s.submissions)
    return shell('<h2>답변이 제출되었습니다.</h2><p>합성 접수 완료 · 외부 응모 아님</p>');
  return shell(`<form method="post" action="${base}"><label>이름<input name="name" required></label><fieldset><legend>경품 우선순위</legend><ol aria-label="경품 우선순위"><li draggable="true" aria-label="쿠폰">쿠폰</li><li draggable="true" aria-label="차">차</li><li draggable="true" aria-label="커피">커피</li></ol></fieldset><fieldset aria-required="true"><legend>합성 인증 파일 *</legend><button type="button" id="pick">Add file</button><div id="files"></div></fieldset><input type="hidden" name="rank"><input type="hidden" name="file"><button type="submit">제출</button></form><script>
let dragged;document.querySelectorAll('li').forEach(el=>{el.ondragstart=e=>{dragged=el;e.dataTransfer.setData('text/plain',el.textContent)};el.ondragover=e=>e.preventDefault();el.ondrop=e=>{e.preventDefault();el.parentElement.insertBefore(dragged,el)}});
document.querySelector('#pick').onclick=()=>{const d=document.createElement('div');d.role='dialog';d.innerHTML='<h2>합성 파일 선택기</h2><input type="file" accept="image/png"><button type="button">Select</button>';document.body.append(d);d.querySelector('button').onclick=()=>{const f=d.querySelector('input').files[0];if(!f)return;const a=document.createElement('a');a.textContent=f.name;document.querySelector('#files').replaceChildren(a);document.querySelector('[name=file]').value=f.name;d.remove()}};
document.querySelector('form').onsubmit=()=>document.querySelector('[name=rank]').value=[...document.querySelectorAll('li')].map(el=>el.textContent).join(',');</script>`);
}
