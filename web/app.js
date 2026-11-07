const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const statuses = {
  queued: '준비',
  running: '진행 중',
  paused: '일시정지',
  needs_user: '직접 확인 필요',
  approval: '확인 대기',
  submission_unknown: '제출 결과 확인 필요',
  completed: '완료',
  failed: '실패',
  stopped: '중지',
};
let state;
let initial = true;
let rendered = '';
function toast(message, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  el.className = error ? 'error' : 'success';
}
async function api(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers:
      data === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'X-Ssal-Token': state?.csrf || '' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '요청을 완료하지 못했습니다.');
  return value;
}
function choice() {
  return {
    kind: $('provider').value,
    accountId: $('account').value || undefined,
    model: $('model').value,
  };
}
function requireChoice() {
  const c = choice();
  if (!c.model) throw new Error('연결 설정에서 모델 목록을 불러오고 모델을 선택해 주세요.');
  return c;
}
function guard(fn) {
  return async (event) => {
    event?.preventDefault();
    try {
      await fn(event);
      await refresh();
    } catch (error) {
      toast(error.message, true);
    }
  };
}
function safeLink(raw, label) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    return `<a href="${esc(u.href)}" target="_blank" rel="noreferrer">${esc(label)} ↗</a>`;
  } catch {
    return '';
  }
}
function render() {
  const auth = state.auth;
  const previous = $('account').value;
  const options = auth.accounts
    .map(
      (a) =>
        `<option value="${esc(a.id)}">${esc(a.label)} · ${esc(a.email || a.id.slice(-8))}${a.connected ? '' : ' (로그인 필요)'}</option>`,
    )
    .join('');
  const accountOptions = options || '<option value="">연결된 계정 없음</option>';
  if ($('account').innerHTML !== accountOptions) {
    $('account').innerHTML = accountOptions;
    if (auth.accounts.some((a) => a.id === previous)) $('account').value = previous;
  }
  if (initial && state.selection) {
    $('provider').value = state.selection.kind;
    if (state.selection.accountId) $('account').value = state.selection.accountId;
    const option = new Option(state.selection.model, state.selection.model);
    $('model').replaceChildren(option);
  }
  initial = false;
  const connected =
    choice().kind === 'api'
      ? auth.apiConfigured
      : auth.accounts.some((a) => a.id === $('account').value && a.connected && a.planEnabled);
  $('connection-badge').textContent = state.busy
    ? '에이전트 작업 중'
    : connected
      ? 'AI 연결됨'
      : 'AI 연결 필요';
  $('auth-note').textContent =
    auth.lastResult === 'plan_permission_missing'
      ? '로그인은 완료됐지만 플랜 사용 권한이 없습니다. 다시 로그인해 권한을 허용하세요.'
      : auth.lastResult && auth.lastResult !== 'connected'
        ? auth.lastResult
        : auth.apiConfigured
          ? 'API 키 설정됨 · 선택한 경로로만 실행합니다.'
          : 'ChatGPT 계정을 연결하거나 API 키를 설정하세요.';
  $('event-count').textContent = state.events.length;
  const contentKey = JSON.stringify({ events: state.events, jobs: state.jobs, busy: state.busy });
  if (contentKey === rendered) return;
  rendered = contentKey;
  $('events').innerHTML = state.events.length
    ? [...state.events]
        .sort((a, b) => b.score - a.score)
        .map((e) => {
          const ended = e.deadlineState === 'ended';
          const blocked = e.deadlineState !== 'available' || e.blockers.length;
          return `<article class="event-card"><div class="card-top"><span class="pill ${blocked ? 'warning' : ''}">${ended ? '마감' : blocked ? '조건 확인 필요' : `검토 우선순위 ${e.score}`}</span><small>${esc(e.organizer)}</small></div><h3>${esc(e.title)}</h3><p class="prize">${esc(e.prize)}</p><dl><dt>마감</dt><dd>${e.deadline ? esc(new Date(e.deadline).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })) : e.deadlineDate ? `${esc(e.deadlineDate)} · 시각 미표기` : '확인되지 않음'}</dd><dt>선정</dt><dd>${e.winners ? `${e.winners}명` : '인원 미확인'} · 추정 소요 ${e.effortMinutes}분</dd></dl><ul>${e.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${e.blockers.length ? `<p class="warning-text">${e.blockers.map(esc).join(' · ')}</p>` : ''}<details><summary>추천 근거와 원문 증거</summary><p>${e.scoreReasons.map(esc).join(' · ')}</p><blockquote>${esc(e.evidenceQuote)}</blockquote><p>${e.evidenceKind === 'image' ? '이미지에서 해석한 조건 · 실행 전 확인 필요' : '원문 텍스트 확인'}</p><a href="/evidence/${esc(e.screenshot)}" target="_blank">확인 당시 화면 ↗</a></details><details class="event-review"><summary>조건 재검토</summary><form data-event-review="${esc(e.id)}"><label>확인한 참여 주소<input name="entryUrl" type="url" required value="${esc(e.entryUrl)}"></label><label>확인한 마감 날짜<input name="deadlineDate" type="date" value="${esc(e.deadlineDate || '')}"></label><label>아직 해결되지 않은 조건 (한 줄씩)<textarea name="blockers">${esc(e.blockers.join('\n'))}</textarea></label><label>원문에서 확인한 내용<textarea name="note" required minlength="5" placeholder="기존 조건을 바꾸는 근거를 적어주세요."></textarea></label><button type="submit" ${state.busy ? 'disabled' : ''}>검토 내용 저장</button></form>${e.reviews?.length ? `<p class="hint">최근 검토: ${esc(e.reviews.at(-1).note)}</p>` : ''}</details><div class="card-actions">${safeLink(e.sourceUrl, '확인한 원문')}${safeLink(e.entryUrl, '참여 페이지')}<button data-apply="${esc(e.id)}" ${blocked || state.busy ? 'disabled' : ''}>응모 준비</button></div></article>`;
        })
        .join('')
    : '<div class="empty">아직 모아둔 기회가 없어요.<br><small>AI를 연결한 뒤 첫 탐색을 시작해 보세요.</small></div>';
  $('jobs').innerHTML = state.jobs.length
    ? state.jobs
        .map(
          (j) =>
            `<article class="job"><div class="section-head"><div><span class="pill ${j.status === 'running' ? 'active' : j.status === 'submission_unknown' ? 'warning' : ''}">${esc(statuses[j.status])}</span><h3>${esc({ discover: '이벤트 탐색', apply: '이벤트 응모', demo: '합성 화면 테스트' }[j.kind])}</h3></div><small>${esc(j.provider.kind === 'chatgpt' ? 'ChatGPT 플랜' : 'OpenAI API')} · ${esc(j.provider.model)}</small></div><p>${esc(j.note)}</p><div class="job-meta">판단 ${j.steps}/${j.maxSteps}회 · 입력 ${j.inputTokens.toLocaleString()} / 출력 ${j.outputTokens.toLocaleString()} 토큰</div>${j.approval ? `<div class="approval"><strong>${j.approval.kind === 'content' ? '입력 내용 확인' : '외부 동작 확인'}</strong><p>${esc(j.approval.url)}</p><p>대상: ${esc(j.approval.target?.label || '화면의 선택 좌표')} ${j.approval.target?.href ? safeLink(j.approval.target.href, '이동 주소') : ''}</p><p>동작: ${esc(j.approval.action.action)} · ${esc(j.approval.action.reason)}</p>${j.approval.action.text ? `<pre>${esc(j.approval.action.text)}</pre>` : ''}<details><summary>현재 폼에 입력된 내용</summary><pre>${esc(JSON.stringify(j.approval.form, null, 2))}</pre></details><p class="hint">이 내용과 현재 화면에 한해 허용됩니다. 화면이 바뀌면 다시 확인합니다.</p><button class="primary" data-action="approve" data-job="${j.id}" data-approval="${j.approval.id}">확인한 동작 실행</button></div>` : ''}<details class="evidence"><summary>관찰 화면과 실행 내역</summary>${j.screenshot ? `<a href="/evidence/${esc(j.screenshot)}" target="_blank"><img loading="lazy" src="/evidence/${esc(j.screenshot)}" alt="이 작업의 최근 브라우저 관찰 화면"></a>` : '<p>아직 관찰 화면이 없습니다.</p>'}<ol>${j.history.map((h) => `<li>${esc(h.reason)} <small>${esc(h.action)}</small></li>`).join('')}</ol></details>${['needs_user', 'paused'].includes(j.status) ? `<details><summary>내 답변 전달하기</summary><form data-job-context="${esc(j.id)}"><p class="hint">현재 질문에 대한 실제 답을 적어주세요. 비밀번호·연락처는 전용 브라우저에 직접 입력하세요.</p><textarea name="text" required maxlength="2000" placeholder="질문과 답변을 함께 적어주세요."></textarea><button type="submit">답변 저장 후 재개</button></form></details>` : ''}<div class="card-actions">${j.status === 'running' ? `<button data-action="pause" data-job="${j.id}">일시정지 · 직접 조작</button><button data-action="stop" data-job="${j.id}">중지</button>` : !['completed', 'stopped'].includes(j.status) ? `${j.status === 'approval' ? `<button data-action="pause" data-job="${j.id}">취소 · 직접 조작</button>` : `<button data-action="resume" data-job="${j.id}" ${state.busy ? 'disabled' : ''}>${j.steps >= j.maxSteps ? '20회 추가해 재개' : '새 화면에서 재개'}</button>`}${['paused', 'needs_user', 'submission_unknown'].includes(j.status) ? `<button data-action="resume-current" data-job="${j.id}" ${state.busy ? 'disabled' : ''}>현재 브라우저 화면에서 재개</button>` : ''}${j.uncertain ? `<button data-action="reconcile" data-job="${j.id}">미제출 직접 확인</button>` : ''}` : ''}</div></article>`,
        )
        .join('')
    : '<div class="empty compact">탐색과 응모 기록이 여기에 쌓입니다.</div>';
}
async function refresh() {
  state = await api('/api/state');
  render();
}
async function beginLogin(accountId) {
  const tab = window.open('about:blank', '_blank');
  try {
    const result = await api('/api/auth/begin', { accountId });
    if (tab) tab.location.href = result.url;
    else window.location.assign(result.url);
  } catch (e) {
    tab?.close();
    throw e;
  }
}
$('chatgpt-login').onclick = guard(() => beginLogin($('account').value || undefined));
$('add-account').onclick = guard(() => beginLogin());
$('discovery-source').onchange = () => {
  $('source-url-field').hidden = $('discovery-source').value !== 'custom';
};
$('reauth').onclick = guard(() => beginLogin($('account').value));
$('key-form').onsubmit = guard(async () => {
  await api('/api/auth/api-key', { key: $('api-key').value });
  $('api-key').value = '';
  toast('API 키를 이 컴퓨터에 저장했습니다.');
});
$('disconnect').onclick = guard(async () => {
  const result = await api('/api/auth/disconnect', choice());
  toast(
    result.revoked
      ? '연결을 해제했습니다.'
      : '로컬 연결은 해제했습니다. 원격 세션 해제는 확인되지 않았으므로 ChatGPT 설정에서도 확인해 주세요.',
  );
});
$('load-models').onclick = guard(async () => {
  const result = await api('/api/models', choice());
  $('model').replaceChildren(...result.models.map((m) => new Option(m.name, m.id)));
  if (!$('model').value) throw new Error('이 연결에서 표시할 모델을 찾지 못했습니다.');
  await api('/api/selection', choice());
  toast('이 계정에서 제공하는 모델 목록을 불러왔습니다.');
});
$('model').onchange = guard(() => api('/api/selection', requireChoice()));
for (const id of ['provider', 'account'])
  $(id).onchange = () => {
    $('model').replaceChildren(new Option('모델 목록을 다시 불러오세요', ''));
    render();
  };
$('browser-form').onsubmit = guard(async () => {
  await api('/api/browser/open', { url: $('login-url').value });
  toast('전용 브라우저에서 로그인하세요. 완료 후 작업을 시작하거나 재개할 수 있습니다.');
});
$('discover-form').onsubmit = guard(async () => {
  await api('/api/jobs', {
    kind: 'discover',
    discoverySource: $('discovery-source').value,
    sourceUrl: $('discovery-source').value === 'custom' ? $('source-url').value : undefined,
    provider: requireChoice(),
    goal: $('goal').value,
    candidateLimit: Number($('candidate-limit').value),
    maxSteps: Number($('step-limit').value),
  });
  toast('탐색을 시작했습니다. 전용 브라우저에서 진행 상황을 볼 수 있습니다.');
});
async function demo(layout) {
  await api('/api/jobs', {
    kind: 'demo',
    provider: requireChoice(),
    goal: '가상의 테스트 이벤트를 화면에서 읽고, 퀴즈 정답과 합성 응원 문구를 입력하고 필수 동의만 체크하여 응모한 뒤 접수번호를 확인하세요. 실제 개인정보는 쓰지 마세요.',
    candidateLimit: 1,
    maxSteps: 30,
    layout,
  });
  toast('선택한 AI로 합성 이벤트 테스트를 시작했습니다.');
}
$('demo').onclick = guard(() => demo('normal'));
$('demo-shift').onclick = guard(() => demo('shift'));
const handleAction = guard(async (event) => {
  const apply = event.target.closest('[data-apply]');
  if (apply) {
    const e = state.events.find((e) => e.id === apply.dataset.apply);
    const provider = requireChoice();
    if (
      !confirm(
        `${e.title}\n\n원문에서 참여 자격과 브라우저 대행이 가능한 범위를 확인했나요?\n필수 과제: ${e.requirements.join(' / ')}\n\n응모 준비를 시작하며, 새 입력 내용과 게시·제출은 따로 확인합니다.`,
      )
    )
      return;
    await api('/api/jobs', {
      kind: 'apply',
      provider,
      goal: `선택한 이벤트의 원문을 다시 확인하고 필수 조건을 충족하여 응모하세요. ${e.requirements.join(' / ')}`,
      eventId: e.id,
      routeConfirmed: true,
      maxSteps: 40,
    });
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, job: id, approval: approvalId } = button.dataset;
  const job = state.jobs.find((j) => j.id === id);
  if (
    action === 'reconcile' &&
    !confirm(
      '현재 브라우저와 접수/댓글 내역을 직접 확인해 실제 제출이 없음을 확인했나요? 이미 제출했다면 취소하세요.',
    )
  )
    return;
  await api(`/api/jobs/${id}/${action === 'resume-current' ? 'resume' : action}`, {
    approvalId,
    useCurrentPage: action === 'resume-current',
    confirmed: action === 'reconcile',
    extraSteps: action === 'resume' && job.steps >= job.maxSteps ? 20 : undefined,
  });
});
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-apply],[data-action]')) void handleAction(event);
});
async function poll() {
  try {
    await refresh();
  } catch (error) {
    toast(`서버 연결 확인 필요: ${error.message}`, true);
  }
  setTimeout(poll, 2000);
}
void poll();

const handleContextForm = guard(async (event) => {
  const form = event.target;
  if (form.matches('[data-event-review]')) {
    const values = new FormData(form);
    await api(`/api/events/${form.dataset.eventReview}/review`, {
      entryUrl: values.get('entryUrl'),
      deadlineDate: values.get('deadlineDate') || null,
      blockers: String(values.get('blockers'))
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
      note: values.get('note'),
    });
    toast('원문 검토 내용을 저장했습니다. 기존 수집 기록도 유지합니다.');
  } else if (form.matches('[data-job-context]')) {
    const id = form.dataset.jobContext;
    await api(`/api/jobs/${id}/context`, { text: new FormData(form).get('text') });
    await api(`/api/jobs/${id}/resume`, {});
  }
});
document.addEventListener('submit', (event) => {
  if (event.target.matches('[data-event-review],[data-job-context]')) void handleContextForm(event);
});
