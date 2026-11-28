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
let renderedBrowserEngine;
let renderedInstagramRevision;
let lastInboxAction;
let rewardFollowupLimit = 20;
let activeJobLimit = 2;
function updateActiveJobVisibility() {
  const cards = [...$('active-jobs').querySelectorAll('[data-activity-job]')];
  cards.forEach((card, index) => {
    card.hidden = index >= activeJobLimit;
  });
  const hidden = cards.slice(activeJobLimit);
  const pending = hidden.filter((card) =>
    ['needs_user', 'approval', 'submission_unknown'].includes(
      state.jobs.find((j) => j.id === card.dataset.activityJob)?.status,
    ),
  ).length;
  $('active-jobs-summary').textContent = cards.length
    ? `최근 생성 순 · ${Math.min(activeJobLimit, cards.length)} / ${cards.length}건 표시${hidden.length ? ` · 접힌 항목 ${hidden.length}건${pending ? ` (사용자 확인 대기 ${pending}건 포함)` : ''}` : ''}`
    : '';
  $('active-jobs-more').hidden = hidden.length === 0;
  $('active-jobs-more').textContent = `${Math.min(10, hidden.length)}건 더 보기`;
  $('active-jobs-less').hidden = activeJobLimit <= 2 || cards.length <= 2;
}
$('active-jobs-more').onclick = () => {
  activeJobLimit += 10;
  updateActiveJobVisibility();
};
$('active-jobs-less').onclick = () => {
  activeJobLimit = 2;
  updateActiveJobVisibility();
  $('attention').scrollIntoView({ block: 'start' });
};
const terminalJob = (job) => ['completed', 'stopped'].includes(job.status);
function delegationIssue(job) {
  const a = job.autonomy;
  if (!a || a.synthetic || job.uncertain || terminalJob(job) || job.archivedAt) return;
  if (!state.autonomy.policy.enabled) return 'disabled';
  if (state.autonomy.revision !== a.revision) return 'changed';
  if (a.expires < Date.now()) return 'expired';
}
const canAnswerInbox = (job) =>
  !job.archivedAt &&
  job.status === 'needs_user' &&
  job.autonomy?.inbox &&
  !delegationIssue(job) &&
  (job.autonomy.synthetic || state.autonomy.revision === job.autonomy.revision);
function jobNote(job) {
  if (job.note === 'server_is_overloaded' && job.notice?.code === job.note)
    return job.notice.reason;
  if (job.note === 'delegation_expired_or_changed')
    return job.notice?.reason || '작업 위임을 갱신해야 합니다.';
  return job.status === 'stopped' &&
    job.note === '브라우저를 직접 조작할 수 있습니다. 재개 시 새 화면부터 확인합니다.'
    ? '작업을 중지했습니다. 추가 답변이나 재개 없이 실행 기록만 보관합니다.'
    : job.note;
}
function renderJobNotice(j) {
  const n = j.notice;
  const stages = {
    ready: '문서 준비',
    controls: '조작 대상 읽기',
    text: '본문 읽기',
    screenshot: '화면 캡처',
    finalize: '관찰 일관성 확인',
  };
  const outcomes = { retrying: '자동 재관찰', recovered: '복구 완료', stopped: '재관찰 중단' };
  const rows = j.observationDiagnostics || [];
  const formRows = j.formDiagnostics || [];
  return `${n ? `<div class="job-notice ${esc(n.category)}"><strong>${esc(n.title)}</strong><p><b>다음 조치</b> · ${esc(n.nextAction)}</p></div>` : ''}${n?.code || rows.length || formRows.length ? `<details class="job-diagnostics"><summary>원인·복구 기록${rows.length + formRows.length ? ` · ${rows.length + formRows.length}건` : ''}</summary>${n?.code ? `<p>${esc(n.code)} · 발생 단계: ${esc(n.phase || '기록 없음')}</p>` : ''}${rows.length ? `<ul>${rows.map((d) => `<li>${esc(new Date(d.at).toLocaleString())} · ${esc(stages[d.stage] || d.stage)} · ${esc(outcomes[d.outcome] || d.outcome)} (${esc(d.attempt)}회)<br><small>${esc(d.code)}</small></li>`).join('')}</ul><p class="hint">화면을 다시 읽은 기록입니다. 클릭·입력·제출을 재실행한 횟수가 아닙니다.</p>` : ''}${formRows.length ? `<ul>${formRows.map((d) => `<li>${esc(new Date(d.at).toLocaleString())} · 폼 ${esc({ retrying: '재관찰·재계획', recovered: '입력 검증 복구 완료', stopped: '복구 중단' }[d.outcome])} · ${d.attempt}회 · ${esc(d.code)} (${esc(d.phase)})</li>`).join('')}</ul><p class="hint">폼 복구는 이미 입력한 값도 다시 검증할 수 있습니다. 제출 재시도 횟수가 아닙니다.</p>` : j.autonomy?.metrics.recoveries ? `<p>이전 폼 자동 복구 ${j.autonomy.metrics.recoveries}회가 있습니다. 구버전의 세부 기록은 실행 기록에서 확인할 수 있습니다.</p>` : ''}</details>` : ''}${renderModelDiagnostics(j)}`;
}
function renderModelDiagnostics(j) {
  if (!j.modelDiagnostics?.length) return '';
  const reasons = {
    call_count: '동작 개수 불일치',
    function_name: '함수 이름 불일치',
    namespace: '도구 그룹 불일치',
    arguments_json: '명령 JSON 해석 실패',
    arguments_schema: '명령 항목·형식 불일치',
    refusal: '모델의 명시적 거절',
    stream_structure: '스트림 완료 항목 불일치',
    stream_reconstructed: '스트림 완료 항목 복원',
  };
  const outcomes = {
    rejected: '검증 거절',
    retrying: '새 화면으로 자동 재요청',
    recovered: '재요청 응답 검증 통과',
    stopped: '해당 응답 복구 중단',
  };
  return `<details class="model-diagnostics"><summary>AI 응답 검증 기록 · ${j.modelDiagnostics.length}건 · 탐색 자동 재요청 ${j.modelFormatRetries || 0}/2회 · 스트림 복원 ${j.modelStreamRecoveries || 0}회</summary><ul>${j.modelDiagnostics.map((d) => `<li><strong>${esc(reasons[d.reason] || d.code)}</strong> · ${esc(d.reason === 'stream_reconstructed' ? '추가 AI 요청 없이 복원' : outcomes[d.outcome] || d.outcome)}<p>반환 동작 ${esc(d.callCount)}개 · 응답 종류 ${esc(d.outputTypes.join(', ') || '없음')} · ${(d.elapsedMs / 1000).toFixed(1)}초 · ${d.usage ? `${esc(d.usage.inputTokens.toLocaleString())} 입력 / ${esc(d.usage.outputTokens.toLocaleString())} 출력 토큰` : '토큰 미보고'}</p>${d.stream ? `<p>스트림에서 완료된 동작 ${esc(d.stream.functionCallsDone)}개 · 마지막 완료 메시지의 출력 ${esc(d.stream.completedOutputCount)}개</p>` : ''}${d.issues?.length ? `<ul>${d.issues.map((i) => `<li>${esc(i.path.join('.') || '최상위')} · ${esc(i.code)}${i.expected?.length ? ` · 허용 값: ${esc(i.expected.join(', '))}` : ''}</li>`).join('')}</ul>` : ''}<small>${esc(new Date(d.at).toLocaleString())} · ${esc(d.code)}</small></li>`).join('')}</ul><p class="hint">형식 검증에서 거절된 응답의 동작은 실행하지 않았습니다. 재요청도 기존 사용량 한도에 포함합니다. 원본 응답·개인정보는 기록하지 않습니다.</p></details>`;
}
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
  if (!response.ok)
    throw new Error(
      value.error === 'consent_decision_required'
        ? '개인정보 동의에서 동의 또는 거부를 직접 선택해 주세요.'
        : value.error === 'delegation_expired_or_changed'
          ? '작업 위임이 만료되었거나 변경됐습니다. 해당 작업의 「위임 갱신하고 현재 화면에서 재개」를 이용해 주세요.'
          : value.error === 'delegation_changed_refresh_required'
            ? '방금 프로필·정책이 변경됐습니다. 새로고침 후 현재 정책으로 다시 확인해 주세요.'
            : value.error === 'budget_decision_limit'
              ? '이 작업의 누적 판단 한도를 모두 사용했습니다. 현재 한도에서는 추가 AI 판단을 재개할 수 없습니다.'
              : value.error || '요청을 완료하지 못했습니다.',
    );
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
      await refresh().catch(() => {});
      const commentErrors = {
        comment_contains_guidance:
          '댓글에 앱 안내문이 섞여 있습니다. 게시할 본문에서 승인·대시보드 조작 안내를 지워 주세요. 아직 게시하지 않았습니다.',
        comment_unresolved_placeholder:
          '댓글에 미완성 표시가 남아 있습니다. 실제 답변으로 바꿔 주세요.',
        comment_personal_answer_required: '댓글에 필요한 개인 의견만 선택하거나 입력해 주세요.',
        comment_personal_answer_mismatch:
          '선택한 개인 답변과 댓글이 다릅니다. ‘선택한 답변으로 댓글 다시 만들기’를 누르거나 본문을 맞춰 주세요.',
        comment_plan_invalid:
          '댓글 질문 구성이 올바르지 않아 게시하지 않았습니다. 초안을 다시 준비해야 합니다.',
      };
      toast(commentErrors[error.message] || error.message, true);
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
function reviewRows(fields) {
  const rows = new Map();
  const names = {
    name: '이름',
    email: '이메일',
    phone: '전화번호',
    region: '지역',
    shippingAddress: '배송 기본 주소',
    shippingAddressDetail: '배송 상세 주소',
    postalCode: '우편번호',
    occupation: '직업',
  };
  for (const [index, field] of fields.entries()) {
    if (['hidden', 'password', 'submit', 'button', 'reset'].includes(field.type)) continue;
    const choice = ['radio', 'checkbox'].includes(field.type);
    const key = choice ? `choice:${field.group || field.name || index}` : `field:${index}`;
    if (!rows.has(key))
      rows.set(key, {
        label: String(
          field.label ||
            names[field.name] ||
            (choice && field.optionLabel) ||
            `항목 ${rows.size + 1}`,
        ).replace(/^답변\s*필수\s*/, ''),
        choice,
        values: [],
      });
    const row = rows.get(key);
    if (choice) {
      if (field.checked) row.values.push(field.optionLabel || '선택됨');
    } else
      row.values.push(
        ...(field.displayValue || [field.value]).map((v) => String(v ?? '')).filter(Boolean),
      );
  }
  return [...rows.values()];
}
function renderFormReview(snapshot, fallbackUrl) {
  const forms = Array.isArray(snapshot) ? snapshot : [];
  const sections = forms
    .map((form) => {
      const rows = reviewRows(form.fields || []);
      const target = form.action || fallbackUrl;
      let domain = '참여 페이지';
      try {
        domain = new URL(target).hostname;
      } catch {}
      return `<section class="submission-review" aria-label="제출 내용 확인">
      <div class="review-heading"><div><span class="review-kicker">제출 대상</span><strong>${safeLink(target, domain)}</strong></div><span class="review-count">${rows.length}개 항목</span></div>
      ${rows.length ? `<dl class="review-answers">${rows.map((row) => `<div class="review-answer"><dt>${esc(row.label)}</dt><dd>${row.values.length ? row.values.map((value) => `<span class="${row.choice ? 'review-choice' : 'review-value'}">${esc(value)}</span>`).join('') : `<span class="review-empty">${row.choice ? '선택 안 함' : '미입력'}</span>`}</dd></div>`).join('')}</dl>` : '<p class="hint">표시할 입력 항목이 없습니다. 관찰 화면에서 내용을 확인해 주세요.</p>'}
    </section>`;
    })
    .join('');
  return `${sections || '<p class="hint">저장된 입력 미리보기가 없습니다. 현재 브라우저 화면을 확인해 주세요.</p>'}<details class="review-raw"><summary>원본 데이터 보기 (JSON)</summary><pre>${esc(JSON.stringify(snapshot ?? [], null, 2))}</pre></details>`;
}
let eventLimit = 20,
  completedLimit = 20;
function notificationHtml(n) {
  const labels = {
    instagram_dm: 'Instagram DM · 응모한 계정',
    direct_message: '개별 메시지 · 계정/서비스는 원문 확인',
    email: '이메일 · 응모 시 등록한 주소',
    sms: '문자 · 응모 시 등록한 번호',
    phone: '전화',
    post_comment: '원문 게시물 댓글',
    story: '주최자 스토리',
    site_notice: '홈페이지·공지사항',
    other: '기타 안내',
  };
  if (!n || n.basis === 'unknown' || !n.channels?.length)
    return `<p class="hint">연락 경로 미확인 · ${esc(n?.reason || '기존 기록에 연락 수단이 없습니다.')}</p>`;
  return `<div class="notification-note"><strong>${n.basis === 'explicit' ? '원문에서 확인한 연락·발표 경로' : '예상 연락·발표 경로'}</strong><p>${n.channels.map((c) => esc(labels[c] || c)).join(' · ')}</p><details><summary>연락 안내 근거</summary><p>${esc(n.reason)}</p>${n.quote ? `<blockquote>${esc(n.quote)}</blockquote>` : ''}${n.sourceUrl ? safeLink(n.sourceUrl, '원문 확인') : ''}</details></div>`;
}
function renderCompleted() {
  const entries = state.completedEntries || [];
  const query = $('completed-search').value.trim().toLocaleLowerCase();
  $('completed-count').textContent = entries.length;
  const shown = entries.filter((e) =>
    `${e.title} ${e.organizer} ${e.prize}`.toLocaleLowerCase().includes(query),
  );
  $('completed-list-count').textContent =
    `검색 결과 ${shown.length}건 중 ${Math.min(shown.length, completedLimit)}건 표시`;
  $('completed-more').hidden = shown.length <= completedLimit;
  $('completed-collapse').hidden = completedLimit <= 20;
  $('completed-entries').innerHTML = shown.length
    ? shown
        .slice(0, completedLimit)
        .map(
          (e) => `<article class="event-card completed-card">
    <div class="card-top"><span class="pill">${e.verification === 'user_reported' ? '수동 완료 · 사용자 보고' : '응모 완료'}</span><small>${esc(e.organizer)}</small></div>
    <h3>${esc(e.title)}</h3><p class="prize">${esc(e.prize)}</p>
    <dl><dt>접수 확인</dt><dd>${esc(new Date(e.completedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}</dd>
    <dt>당첨 발표</dt><dd>${esc(e.announcementDate || e.announcementNote || '일정 미확인')}</dd>
    <dt>당첨 결과</dt><dd>${esc(outcomeLabel(e.eventId))}</dd></dl>
    ${notificationHtml(e.winnerNotice)}<details><summary>접수 증거 확인</summary><blockquote>${esc(e.quote)}</blockquote>
    <p class="hint">${e.verification === 'user_reported' ? '사용자 완료 보고 · 앱 접수 검증 없음' : e.verification.includes('developer') ? '개발자 검토로 완료 상태 복구' : e.verification === 'autonomous_native_alert' ? '제출 응답과 연결된 접수 완료 알림 확인' : e.verification === 'autonomous_response_receipt' ? '제출 응답에서 접수 완료 확인' : e.verification === 'autonomous_semantic_receipt' ? '앱이 응답·알림·화면의 의미를 검토함' : '완료 화면 확인'}</p>
    ${e.screenshot ? `<a href="/evidence/${esc(e.screenshot)}" target="_blank" rel="noreferrer">접수 당시 화면 ↗</a>` : ''}</details>
    ${renderReceiptCheck(e.receiptCheck)}${renderConsents(e.consents)}<div class="card-actions"><button data-outcome="${esc(e.eventId)}">결과·경품 관리</button>${rewardProgressButtons(e.eventId)}${safeLink(e.sourceUrl, '이벤트 원문')}${safeLink(e.entryUrl, '참여 페이지')}</div></article>`,
        )
        .join('')
    : `<div class="empty">${query ? '검색 결과가 없습니다.' : '완료한 응모가 여기에 모입니다.'}</div>`;
}
function conditionDetails(e) {
  const checks = e.assessment?.conditions || [];
  if (!checks.length || e.lifecycle?.status !== 'candidate' || e.deadlineState === 'ended')
    return '';
  const status = { yes: '충족', no: '불일치', unknown: '미확인' };
  return `<div class="candidate-reasons"><strong>참가 자격</strong><ul>${checks
    .map(
      (c) =>
        `<li>${esc(c.label)} · ${status[c.value]}<small> · ${esc(c.basis || (c.scope === 'event' ? '이 행사' : '프로필'))}</small></li>`,
    )
    .join('')}</ul>
    <a href="#qualification-profile">프로필에서 참가 자격 설정</a>
    ${checks.some((c) => c.scope === 'event' || c.kind === 'service') ? `<button type="button" data-qualification-event="${esc(e.id)}">행사별 자격 확인</button>` : ''}</div>`;
}
function deadlineDetails(e) {
  if (!e.canCheckDeadline || e.lifecycle?.status !== 'candidate') return '';
  const c = e.deadlineCheck;
  return `<div class="candidate-reasons">${c ? `<strong>당일 접수 재확인</strong><p>${esc(c.reason)}</p><small>${esc(new Date(c.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}</small>` : ''}<button type="button" data-deadline-check="${esc(e.id)}" ${state.busy ? 'disabled' : ''}>공식 원문에서 접수 상태 재확인</button></div>`;
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-deadline-check]');
  if (button)
    void guard(async () => {
      button.disabled = true;
      try {
        const c = await api(
          '/api/events/' + button.dataset.deadlineCheck + '/recheck-deadline',
          {},
        );
        toast(c.reason);
      } finally {
        button.disabled = false;
      }
    })(event);
});
function candidateBadge(e, blocked) {
  if (e.lifecycle && e.lifecycle.status !== 'candidate') return e.lifecycle.label;
  if (e.submissionState === 'completed') return '응모 완료';
  if (e.deadlineState === 'ended') return '마감';
  if (e.deadlineState === 'closing_today') return '오늘 마감 · 시각 미확인';
  if (e.assessment?.conditions?.some((c) => c.value === 'no')) return '참가 자격 불일치';
  if (e.assessment?.state === 'excluded') return '선정 기준 제외';
  if (e.assessment?.conditions?.some((c) => c.value === 'unknown')) return '참가 자격 확인 필요';
  if (e.preparationReasons?.includes('자동 준비를 검증한 참여 경로가 아닙니다.'))
    return '자동 준비 경로 미검증';
  return blocked ? '조건 확인 필요' : `검토 우선순위 ${e.assessment?.score ?? e.score}`;
}
function renderEntryBatch() {
  const plan = state.entryBatchPlan;
  $('entry-batch-panel').hidden = !plan;
  if (!plan) return;
  const b = state.entryBatch;
  const active = b?.state === 'running';
  const start = $('entry-batch-start');
  start.hidden = active;
  start.disabled = !plan.ids.length || !state.autonomy.policy.enabled;
  start.textContent = `응모 가능 ${plan.ids.length}건 순차 시작`;
  $('entry-batch-stop').hidden = !active;
  const current = active && b.items.find((i) => i.state === 'current');
  const job = current && state.jobs.find((j) => j.id === current.jobId);
  const waiting = job && !['queued', 'running', 'completed'].includes(job.status);
  const policy =
    state.autonomy.policy.finalSubmit === 'auto'
      ? '위임한 최종 제출은 자동으로 진행합니다.'
      : '최종 제출은 확인함에서 승인합니다.';
  const done = b?.items.filter((i) => i.state === 'completed').length || 0;
  const skipped = b?.items.filter((i) => i.state === 'skipped').length || 0;
  $('entry-batch-status').textContent = active
    ? `전체 ${b.items.length}건 · 접수 완료 ${done}건 · 건너뜀 ${skipped}건. ${waiting ? '현재 건의 확인을 기다립니다.' : b.note}`
    : `${b ? b.note + ' 완료 ' + done + '건 · 건너뜀 ' + skipped + '건. ' : ''}${state.autonomy.policy.enabled ? '시작 시점에 응모 가능한 전체 후보를 선정 점수순으로 진행합니다. ' + policy : '프로필·위임 정책에서 자율 응모를 켜 주세요.'}`;
  $('entry-batch-current').innerHTML = current
    ? `<p><strong>${esc(current.title)}</strong> <button type="button" data-entry-job="${esc(current.jobId)}">${waiting ? '확인함 열기' : '현재 작업 보기'}</button></p>`
    : '';
  const labels = { pending: '대기', current: '진행', completed: '접수 완료', skipped: '건너뜀' };
  $('entry-batch-previous').hidden = active || !b;
  $('entry-batch-results').innerHTML =
    b && !active
      ? b.items
          .map((i) => {
            const status =
              i.state === 'pending'
                ? '미시작'
                : i.state === 'current'
                  ? '개별 작업 확인'
                  : labels[i.state];
            return `<li>${esc(i.title)} · ${esc(status)} ${esc(i.note || '')}</li>`;
          })
          .join('')
      : '';
  const rows = active ? b.items : plan.ids.map((id) => ({ eventId: id }));
  $('entry-batch-summary').textContent = active
    ? '진행 순서와 결과 보기'
    : '이번에 진행할 후보 보기';
  $('entry-batch-items').innerHTML = rows
    .map((i) => {
      const e = state.events.find((e) => e.id === i.eventId);
      return `<li>${esc(i.title || e?.title)} · ${esc(i.state ? labels[i.state] : (e?.requirements || []).join(' / '))} ${i.note ? esc(i.note) : ''} ${e ? safeLink(e.sourceUrl, '원문') : ''}</li>`;
    })
    .join('');
}
$('entry-batch-start').onclick = guard(async () => {
  const provider = requireChoice();
  $('entry-batch-start').disabled = true;
  await api('/api/entry-batch', { provider, key: state.entryBatchPlan.key });
});
$('entry-batch-stop').onclick = guard(async () => {
  await api('/api/entry-batch/stop', { id: state.entryBatch.id });
});
function renderEvents() {
  if (!state) return;
  renderEntryBatch();
  const filter = $('event-filter').value,
    query = $('event-search').value.trim().toLocaleLowerCase();
  const rows = state.events
    .filter((e) => `${e.title} ${e.organizer} ${e.prize}`.toLocaleLowerCase().includes(query))
    .filter((e) => {
      if (filter === 'all') return true;
      if (filter === 'qualifications')
        return (
          e.lifecycle?.status === 'candidate' &&
          e.deadlineState !== 'ended' &&
          e.assessment?.conditions?.some((c) => c.value === 'unknown')
        );
      if (filter === 'unfinished')
        return !e.lifecycle?.hiddenByDefault && e.submissionState !== 'completed';
      if (filter === 'unknown') return e.lifecycle?.unknown && e.submissionState !== 'completed';
      if (filter === 'manual' || filter === 'dropped') return e.lifecycle?.status === filter;
      if (filter === 'stopped') return ['stopped', 'failed', 'held'].includes(e.lifecycle?.status);
      if (filter === 'completed') return e.submissionState === 'completed';
      const ready = e.assessment?.state === 'eligible' && !e.preparationReasons?.length;
      return (
        !e.submissionState &&
        !e.lifecycle?.hiddenByDefault &&
        (filter === 'eligible' ? ready : !ready)
      );
    });
  rows.sort(
    $('event-sort').value === 'score'
      ? (a, b) => (b.assessment?.score ?? b.score) - (a.assessment?.score ?? a.score)
      : (a, b) => b.foundAt.localeCompare(a.foundAt),
  );
  $('event-list-count').textContent =
    `전체 ${state.events.length}건 · 필터 결과 ${rows.length}건 중 ${Math.min(rows.length, eventLimit)}건 표시`;
  $('events-more').hidden = rows.length <= eventLimit;
  $('events-collapse').hidden = eventLimit <= 20;
  $('events').innerHTML = rows.length
    ? rows
        .slice(0, eventLimit)
        .map((e) => {
          const remaining = e.assessment?.remainingBlockers ?? e.blockers;
          const blocked =
            (e.assessment && e.assessment.state !== 'eligible') ||
            e.deadlineState !== 'available' ||
            remaining.length ||
            e.preparationReasons?.length ||
            e.submissionState;
          return `<article class="event-card"><div class="card-top"><span class="pill ${blocked ? 'warning' : ''}">${esc(candidateBadge(e, blocked))}</span><small>${esc(e.organizer)}</small></div><h3>${esc(e.title)}</h3><p class="prize">${esc(e.prize)}</p>${e.lifecycle?.reason ? `<p class="entry-reason">${esc(e.lifecycle.reason)}</p>` : ''}<dl><dt>마감</dt><dd>${e.deadline ? esc(new Date(e.deadline).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })) : e.deadlineDate ? `${esc(e.deadlineDate)} · 시각 미표기` : '확인되지 않음'}</dd><dt>선정</dt><dd>${e.winners ? `${e.winners}명` : '인원 미확인'} · 추정 소요 ${e.effortMinutes}분</dd></dl><div class="candidate-reasons"><strong>${e.preparationReasons?.length ? '자동 준비 보류 이유' : '선정 이유'}</strong><ul>${(e.preparationReasons?.length ? e.preparationReasons : e.assessment?.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${e.assessment?.adjustments?.length ? '<a href="#selection-policy">운영 탭에서 조건 조정</a>' : ''}</div><ul>${e.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${deadlineDetails(e)}${conditionDetails(e)}${remaining.length ? `<p class="warning-text">${remaining.map(esc).join(' · ')}</p>` : ''}<details><summary>추천 근거와 원문 증거</summary><p>${e.scoreReasons.map(esc).join(' · ')}</p><blockquote>${esc(e.evidenceQuote)}</blockquote><p>${e.evidenceKind === 'image' ? '이미지에서 해석한 조건 · 실행 전 확인 필요' : '원문 텍스트 확인'}</p><a href="/evidence/${esc(e.screenshot)}" target="_blank">확인 당시 화면 ↗</a></details><details class="event-review"><summary>조건 재검토</summary><form data-event-review="${esc(e.id)}"><label>확인한 참여 주소<input name="entryUrl" type="url" required value="${esc(e.entryUrl)}"></label><label>확인한 마감 날짜<input name="deadlineDate" type="date" value="${esc(e.deadlineDate || '')}"></label><label>아직 해결되지 않은 조건 (한 줄씩)<textarea name="blockers">${esc(e.blockers.join('\n'))}</textarea></label><label>원문에서 확인한 내용<textarea name="note" required minlength="5" placeholder="기존 조건을 바꾸는 근거를 적어주세요."></textarea></label><button type="submit" ${state.busy ? 'disabled' : ''}>검토 내용 저장</button></form>${e.reviews?.length ? `<p class="hint">최근 검토: ${esc(e.reviews.at(-1).note)}</p>` : ''}</details><div class="card-actions">${safeLink(e.sourceUrl, '확인한 원문')}${safeLink(e.entryUrl, '참여 페이지')}<button data-apply="${esc(e.id)}" ${blocked || state.busy ? 'disabled' : ''}>${e.submissionState === 'completed' ? '응모 완료' : e.submissionState ? esc(e.lifecycle?.label || '기존 작업 확인') : '응모 준비'}</button>${e.lifecycle?.canManage ? `<button data-entry-manage="${esc(e.id)}" ${state.busy ? 'disabled' : ''}>처리 방법 선택</button>` : ''}</div></article>`;
        })
        .join('')
    : '<div class="empty">현재 필터에 맞는 기회가 없습니다.</div>';
  $('source-exclusions').innerHTML =
    (state.sourceExclusions || [])
      .slice(0, 20)
      .map((r) => `<p>${safeLink(r.url, '제외한 출처')} · ${esc(r.reason)}</p>`)
      .join('') || '<p class="hint">저장된 출처 제외 기록이 없습니다.</p>';
}

document.addEventListener('click', (event) => {
  const view = event.target.closest('[data-entry-job]');
  if (view) {
    $('entry-manager').close();
    const card = $(`job-${view.dataset.entryJob}`);
    if (card?.hidden) {
      const index = [...$('active-jobs').querySelectorAll('[data-activity-job]')].indexOf(card);
      if (index >= 0) {
        activeJobLimit = Math.max(activeJobLimit, index + 1);
        updateActiveJobVisibility();
      }
    }
    const details = card?.closest('details');
    if (details) details.open = true;
    card?.scrollIntoView({ block: 'start' });
    return;
  }
  const button = event.target.closest('[data-entry-manage]');
  if (!button) return;
  const e = state.events.find((e) => e.id === button.dataset.entryManage),
    l = e.lifecycle;
  const mode = e.management?.mode || 'active';
  const restoreControl = l.manualUnconfirmed
    ? '<details><summary>자율 응모로 돌아가기</summary><p class="hint">수동 참여가 없었는지 확인해야 자동 실행을 다시 요청할 수 있습니다. 기존 제출 기록은 유지됩니다.</p><label class="check"><input type="checkbox" name="confirmedNoParticipation">좋아요·팔로우·댓글·폼 전송 등 외부 참여 동작을 하지 않았음을 직접 확인했습니다.</label><button name="action" value="active">미참여 확인 저장·기회 복원</button></details>'
    : '<button name="action" value="active">진행할 기회로 복원</button>';
  $('entry-manager-content').innerHTML = `<h2 id="entry-manager-title">${esc(e.title)}</h2>
    <p><strong>${esc(l.label)}</strong> · ${esc(l.reason)}</p>
    ${l.unknown ? '<p class="warning-text">제출했을 수 있습니다. 재응모하지 말고 접수 내역을 확인하세요. 드랍해도 중복 방지 기록은 유지됩니다.</p>' : ''}
    ${l.jobId ? `<p><button data-entry-job="${esc(l.jobId)}">기존 작업·결과 확인</button></p>` : ''}
    <form data-entry-resolution="${esc(e.id)}">
      <label>추가 답변·처리 메모 (선택)<textarea name="context" maxlength="2000" placeholder="이전 중단 사유를 해결할 답변이나 변경 사항을 적어주세요. 실제 경험은 본인이 알려주세요."></textarea></label>
      ${mode === 'active' ? `<div class="inline"><button name="action" value="dropped">드랍 · 목록에서 정리</button><button name="action" value="manual">수동 진행으로 전환</button></div>${l.manualUnconfirmed ? restoreControl : ''}` : `${mode === 'manual' ? '<button name="action" value="dropped">드랍 · 목록에서 정리</button>' : ''}${restoreControl}`}
      ${l.canRetry ? '<p class="hint">기존 기록과 사용량은 보존합니다. 현재 원문을 다시 확인하고, 참여 가능하면 저장된 위임으로 준비합니다. 필요한 게시·제출 승인은 확인함에서 받습니다.</p><button name="action" value="retry">원문 재확인 후 자율 재도전</button>' : e.submissionState && mode === 'active' ? `<p class="hint">${esc(l.retryBlockedReason)}</p>` : ''}
    </form>
    ${mode === 'manual' ? `<section><h3>직접 참여</h3><p>기존 완료 과제와 접수 내역을 확인하고 남은 과제만 진행하세요. 일반 브라우저 로그인은 앱과 공유되지 않습니다.</p><ul>${e.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul><button data-external="${esc(e.entryUrl)}">참여 페이지를 일반 브라우저에서 열기</button><form data-entry-complete="${esc(e.id)}"><label>확인한 완료 근거<textarea name="evidence" required minlength="10" maxlength="2000" placeholder="직접 확인한 접수 문구·본인 댓글·완료 시각 등을 적어주세요."></textarea></label><label class="check"><input type="checkbox" name="confirmed" required>필수 과제를 모두 완료했고 접수 또는 참여 내역을 직접 확인했습니다.</label><button type="submit">수동 완료로 기록</button><p class="hint">완료 목록에 ‘사용자 완료 보고’로 표시합니다. 앱이 검증한 결과로 표시하지 않습니다.</p></form></section>` : ''}`;
  $('entry-manager').showModal();
});
document.addEventListener('submit', (event) => {
  if (!event.target.matches('[data-entry-resolution],[data-entry-complete]')) return;
  void guard(async (event) => {
    const form = event.target,
      values = new FormData(form);
    const id = form.dataset.entryResolution || form.dataset.entryComplete;
    if (form.dataset.entryComplete) {
      await api(`/api/events/${id}/manual-complete`, {
        confirmed: values.has('confirmed'),
        evidence: values.get('evidence'),
      });
      toast('사용자 완료 보고를 기록했습니다. 완료한 응모에서 확인하세요.');
    } else {
      const action = event.submitter.value;
      if (action === 'retry') {
        await api(`/api/events/${id}/retry`, {
          provider: requireChoice(),
          context: values.get('context'),
        });
        location.hash = 'attention';
        toast('이 이벤트의 원문부터 다시 확인합니다. 필요한 승인은 확인함에 표시됩니다.');
      } else {
        await api(`/api/events/${id}/manage`, {
          mode: action,
          confirmedNoParticipation: values.has('confirmedNoParticipation'),
          note: String(values.get('context')).slice(0, 1000),
        });
        if (action === 'manual') $('event-filter').value = 'manual';
        toast(
          action === 'dropped'
            ? '드랍했습니다. 드랍 필터에서 복원할 수 있습니다.'
            : action === 'manual'
              ? '수동 진행 목록으로 옮겼습니다. 처리 방법 선택에서 직접 참여·완료 기록을 이어가세요.'
              : '기회를 복원했습니다. 자동으로 재시작하지 않습니다.',
        );
      }
    }
    $('entry-manager').close();
  })(event);
});

function renderConsents(rows = []) {
  if (!rows.length) return '';
  const names = {
    accept: '동의',
    decline: '거부·미선택',
    ask: '직접 확인 필요',
    skip: '응모 중단',
  };
  return `<details class="consent-audit"><summary>동의 판단 내역 · ${rows.length}건</summary>${rows.map((c) => `<div class="consent-decision"><strong>${esc(c.question)}</strong><p><span class="pill ${c.decision === 'ask' || c.decision === 'skip' ? 'warning' : ''}">${esc(names[c.decision])}</span> ${c.actor === 'user' ? '사용자가 직접 선택' : `위임 ${{ manual: 1, routine: 2, adaptive: 3 }[c.mode]}단계`}</p><p>${esc(c.reason)}</p><p class="hint">${c.appliedAt ? '선택 입력 확인됨' : '판단 기록 · 아직 입력 확인 전'}</p>${c.recipient || c.retention ? `<p class="hint">${esc(c.recipient || '수신자 확인 필요')} · ${esc(c.retention || '보관 기간 확인 필요')}</p>` : ''}<details><summary>당시 동의 원문</summary><p class="consent-notice">${esc(c.notice)}</p><small>${esc(new Date(c.at).toLocaleString('ko-KR'))} · 정책 ${esc(c.revision.slice(0, 8))}</small></details></div>`).join('')}</details>`;
}
function renderInboxQuestion(q, origin) {
  const fields = `<fieldset ${q.blocker ? 'data-quiz-fields hidden disabled' : ''} data-question="${esc(q.id)}" ${q.condition ? `data-condition-parent="${esc(q.condition.questionId)}" data-condition-option="${esc(q.condition.optionId)}"` : ''}><legend>${esc(q.label)}</legend>${q.description ? `<details><summary>질문 설명·동의 내용</summary><p>${esc(q.description)}</p></details>` : ''}${q.category === 'consent' && q.kind === 'checkbox' && q.options.length === 1 ? `<label class="check"><input type="radio" name="${esc(q.id)}" value="${esc(q.options[0].id)}" required>동의합니다</label><label class="check"><input type="radio" name="${esc(q.id)}" value="__ssal_decline__" required>동의하지 않습니다</label>` : q.kind === 'file' ? renderAttachmentQuestion(q, origin) : q.kind === 'rank' ? q.options.map((_, i) => `<label>${i + 1}순위<select name="${esc(q.id)}" required><option value="">선택</option>${q.options.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select></label>`).join('') : q.kind === 'text' ? (q.reviewDraft || q.draftEligible ? `<textarea name="${esc(q.id)}" rows="3" ${q.required ? 'required' : ''} maxlength="${Math.min(q.maxLength ?? 2000, 2000)}" autocomplete="off">${esc(q.recommended?.[0] || '')}</textarea>` : `<input name="${esc(q.id)}" ${q.required ? 'required' : ''} maxlength="${Math.min(q.maxLength ?? 2000, 2000)}" autocomplete="off">`) : q.options.map((o) => `<label class="check"><input type="${q.multiple ? 'checkbox' : 'radio'}" name="${esc(q.id)}" value="${esc(o.id)}" ${!q.multiple && q.required ? 'required' : ''}>${esc(o.label)}</label>`).join('')}${q.multiple && q.maxChoices ? `<p class="hint">${q.minChoices === q.maxChoices ? `정확히 ${q.maxChoices}개 선택` : `최대 ${q.maxChoices}개 선택`}</p>` : ''}${q.kind === 'text' && q.maxLength !== undefined ? `<p class="hint">사이트 입력 제한: ${q.maxLength}자</p>` : ''}${q.condition ? '<p class="hint">앞 문항에서 ‘기타’를 선택한 경우에만 작성합니다.</p>' : ''}${q.reviewDraft ? '<p class="hint">AI 검토용 초안 · 내용을 확인하고 필요하면 수정하세요. 실제 이용 경험을 확인한 답변은 아닙니다.</p>' : ''}${q.recommended ? `<p class="hint">추천: ${q.recommended.map(esc).join(', ')}</p>` : `<p class="hint">${q.proofAttachment ? '캡처를 직접 만들 필요 없이, 준비한 이미지와 첨부 동의만 확인하세요.' : q.category === 'consent' ? esc(q.reason) : '저장된 답이 없어 직접 확인이 필요합니다.'}</p>`}</fieldset>`;
  if (!q.blocker) return fields;
  const d = q.blocker.diagnostic;
  const diagnostic = d
    ? `<details><summary>조회 오류·복구 상세</summary><p>${esc(d.errorName)} · ${esc(d.phase)} · ${d.recovery === 'reobserve' ? '새 화면에서 재판단 요청' : '조사 중단'}</p><p>${esc(d.message)}</p><p class="hint">${esc((d.frames || []).join(' · '))}</p></details>`
    : '';
  return `<article class="quiz-blocker"><strong>${esc(q.label)}</strong><p>${esc(q.blocker.reason)}</p>${q.blocker.planReason ? `<p class="hint">${esc(q.blocker.planReason)}</p>` : ''}<p class="hint">${esc(q.blocker.code)}${q.blocker.calls !== undefined ? ` · 이 문항 조사 ${q.blocker.calls}회` : ''}${q.blocker.legacy ? ' · 이전 실행은 공통 조사 기록만 남아 있습니다.' : ''}</p>${diagnostic}${fields}</article>`;
}
function renderKnowledgeSummary(rows = []) {
  if (!rows.length) return '';
  return `<details class="prepared-knowledge"><summary>준비된 퀴즈 답안 · ${rows.length}개 (입력·제출 전 준비 기록)</summary>${rows.map((q) => `<article><strong>${esc(q.label)}</strong><p>${(q.answer || []).map(esc).join(', ')}</p><p>${esc(q.reason)}</p><p class="hint">${esc(q.source)} ${q.url ? safeLink(q.url, '근거 원문 열기') : ''}</p>${q.quote ? `<blockquote>${esc(q.quote)}</blockquote>` : ''}</article>`).join('')}</details>`;
}
function syncManualQuiz(form) {
  const toggle = form.querySelector('[data-manual-quiz]');
  if (!toggle) return;
  for (const field of form.querySelectorAll('[data-quiz-fields]')) {
    field.hidden = !toggle.checked;
    field.disabled = !toggle.checked;
  }
  const submit = form.querySelector('button[type=submit]');
  if (submit && !submit.dataset.preparing) submit.disabled = !toggle.checked;
}

function renderInbox(job) {
  const a = job.autonomy;
  if (!a) return '';
  const m = a.metrics;
  const metrics = `<p class="hint">묶음 ${m.batches}회 · 입력 검증 ${m.fields}개 · 답변 재사용 ${m.reused}개 · 확인 요청 ${m.inboxBatches}회 · 자동 복구 ${m.recoveries}회 · 모델 ${(m.modelMs / 1000).toFixed(1)}초 / 관찰·입력 ${(m.browserMs / 1000).toFixed(1)}초</p>${renderConsents(a.consents)}`;
  if (job.archivedAt || terminalJob(job))
    return (
      metrics +
      (!job.archivedAt &&
      job.status === 'stopped' &&
      job.note.startsWith('동의 정책에 따라') &&
      !job.transmitted &&
      !job.uncertain &&
      !m.fields &&
      !m.batches
        ? `<button data-review-consent="${job.id}">동의 선택 다시 검토</button>`
        : '')
    );
  const issue = delegationIssue(job);
  if (issue)
    return (
      metrics +
      `<div class="delegation-review"><strong>${issue === 'expired' ? '작업 위임 24시간 만료' : issue === 'disabled' ? '자율 응모 위임 꺼짐' : '프로필·위임 정책 변경'}</strong><p>${issue === 'expired' ? '저장된 답변과 사용량은 보존되어 있습니다. 이 작업에 같은 정책을 다시 적용하면 현재 화면에서 이어갑니다.' : issue === 'disabled' ? '05 프로필·위임 정책에서 위임을 켠 뒤 이 작업에 적용해 주세요.' : '변경된 프로필·정책으로 답변을 다시 검토합니다. 이전 자동 판단과 제출 승인은 재사용하지 않습니다.'}</p><p class="hint">대상: ${esc(a.origin)} · 기존 만료: ${esc(new Date(a.expires).toLocaleString())}<br>최종 제출: ${state.autonomy.policy.finalSubmit === 'auto' ? '자동' : '확인함에서 직접 확인'} · 사용량·복구 한도는 초기화하지 않습니다.</p>${issue === 'disabled' ? '<a href="#autonomy">프로필·위임 정책 보기</a>' : `<button data-action="renew-resume-current" data-job="${job.id}" ${state.busy ? 'disabled' : ''}>위임 갱신하고 현재 화면에서 재개</button>`}</div>`
    );
  const box = a.inbox;
  if (!box) return metrics;
  if (!canAnswerInbox(job))
    return (
      metrics +
      (['paused', 'failed'].includes(job.status)
        ? '<p class="hint">일시정지된 확인함입니다. 현재 브라우저 화면에서 재개하면 질문을 다시 확인합니다.</p>'
        : '')
    );
  const blockedCount = box.items.filter((q) => q.blocker).length;
  const uncertainStage = box.final && /^(다음|next|continue)$/i.test(box.buttonLabel || '');
  return (
    metrics +
    renderKnowledgeSummary(a.knowledgeSummary) +
    `<div class="approval"><h3>확인함 · ${box.final ? (uncertainStage ? '이 단계 전송 검토' : '최종 제출') : `직접 확인 ${box.items.length - blockedCount}개${blockedCount ? ` · 정답 조사 중단 ${blockedCount}개` : ''}`}</h3><form data-inbox="${job.id}" data-inbox-id="${box.id}">${
      box.final
        ? `<p>${uncertainStage ? '이 단계의 답변을 전송합니다. 마지막 단계인지 확인되지 않았으며, 추가 문항이 나오면 계속 진행합니다.' : '입력 내용을 확인한 뒤 이 응모의 최종 제출을 허용합니다.'}</p>${renderFormReview(box.review, job.currentUrl)}<button type="submit" class="primary">${uncertainStage ? '확인한 답변 전송하고 계속' : '최종 제출하고 결과 확인'}</button>`
        : box.items
            .filter((q) => !q.blocker)
            .map((q) => renderInboxQuestion(q, a.origin))
            .join('') +
          (blockedCount
            ? `<h4>앱의 정답 조사 중단 · ${blockedCount}개</h4><p>아래는 개인 의견 요청이 아닙니다. 공개 근거 재조사 또는 직접 알고 있는 답의 수동 입력으로 해결할 수 있습니다.</p>${box.items
                .filter((q) => q.blocker)
                .map((q) => renderInboxQuestion(q, a.origin))
                .join(
                  '',
                )}<label class="check"><input type="checkbox" name="__manual_quiz" value="yes" data-manual-quiz>직접 알고 있는 퀴즈 답을 수동으로 입력</label>`
            : '') +
          `${box.drafts?.reason ? `<p class="hint">${esc(box.drafts.reason)}</p>` : ''}${!state.browser.open && !box.final && !m.fields && !m.batches ? `<button type="button" data-restore-form="${job.id}">입력 전 응모 화면 복원</button>` : ''}${!box.drafts && box.items.some((q) => q.draftEligible && !q.recommended) ? `<button type="button" data-prepare-drafts="${job.id}">서술형 AI 초안 준비</button>` : box.drafts?.status === 'preparing' ? '<p class="hint">AI 초안을 준비하고 있습니다…</p>' : ''}<button type="button" data-recommend="${job.id}">추천 답변 모두 선택</button><label class="check"><input type="checkbox" name="remember"> 이 사이트의 같은 질문에 답변 재사용${a.synthetic ? ' (합성 테스트에서는 저장하지 않음)' : ''}</label><button class="primary" type="submit" ${box.drafts?.status === 'preparing' ? 'data-preparing="true"' : ''} ${box.drafts?.status === 'preparing' || blockedCount ? 'disabled' : ''}>한 번에 답변하고 재개</button>`
    }</form>${!box.final && box.items.some((q) => q.category === 'knowledge') && ((a.researchRetries || 0) < 2 || a.statisticsUpgradeRetry) && (a.researchBudget?.remaining ?? 1) > 0 ? `<button type="button" data-action="retry-research" data-job="${job.id}">공개 근거 다시 찾기</button>` : ''}</div>`
  );
}
function renderAttachmentQuestion(q, origin) {
  const proof = q.proofAttachment;
  return `${proof ? `<div class="proof-attachment"><strong>${esc(proof.kind)} 인증 캡처 준비됨</strong><a href="/evidence/${esc(proof.screenshot)}" target="_blank" rel="noreferrer"><img src="/evidence/${esc(proof.screenshot)}" alt="${esc(proof.kind)} 인증 캡처 미리보기" loading="lazy"></a><p class="hint">${esc(new Date(proof.observedAt).toLocaleString())}에 이 작업에서 완료 확인한 실제 화면 · ${(proof.size / 1024).toFixed(0)}KB</p><p><a href="${esc(proof.sourceUrl)}" target="_blank" rel="noreferrer">인증 대상 보기 ↗</a> · 이미지를 눌러 전체 화면 확인</p><p class="hint">별도 파일을 선택하면 준비한 캡처 대신 첨부합니다.</p></div>` : ''}<label>${proof ? '다른 파일로 바꾸기 (선택)' : '인증 파일 선택'}<input name="${esc(q.id)}" type="file" accept=".png,.jpg,.jpeg,.pdf" ${q.required && !q.picker && !proof ? 'required' : ''}></label>${q.picker ? `<label>또는 Drive에서 선택할 정확한 파일명<input name="drive-${esc(q.id)}" maxlength="180" placeholder="같은 이름이 여러 개면 직접 선택이 필요합니다"></label>` : ''}<label class="check"><input type="checkbox" name="upload-${esc(q.id)}" ${q.required ? 'required' : ''}>${proof ? '위 캡처(또는 바꾼 파일)의 포함 내용을 확인했으며' : '선택한 실제 파일을'} ${q.picker ? 'Google Drive 및 ' : ''}${esc(origin)}의 응모 주최자에게 첨부하는 데 동의합니다 (최대 5MB).</label>`;
}
const inboxStorageKey = (form) => `ssal-inbox:${form.dataset.inbox}:${form.dataset.inboxId}`;
function readInboxEdits(form) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(inboxStorageKey(form)) || 'null');
    return saved && Date.now() - saved.at < 86400000 ? saved.answers : {};
  } catch {
    return {};
  }
}
function savedInboxValue(form, name) {
  return readInboxEdits(form)[name];
}
function syncInboxConditions(form) {
  for (const field of form.querySelectorAll('[data-condition-parent]')) {
    const selected = new FormData(form).getAll(field.dataset.conditionParent);
    const active = selected.includes(field.dataset.conditionOption);
    for (const el of field.querySelectorAll('input,textarea')) {
      el.disabled = !active;
      el.hidden = !active;
    }
  }
}
function restoreInboxEdits() {
  const live = new Set();
  for (const form of document.querySelectorAll('[data-inbox]')) {
    live.add(inboxStorageKey(form));
    const values = readInboxEdits(form);
    for (const el of form.elements) {
      const answer = values[el.name];
      if (!answer || ['file', 'password'].includes(el.type)) continue;
      if (['checkbox', 'radio'].includes(el.type)) el.checked = answer.includes(el.value);
      else el.value = answer[0] || '';
    }
    syncInboxConditions(form);
    syncManualQuiz(form);
  }
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith('ssal-inbox:') && !live.has(key)) sessionStorage.removeItem(key);
}
function saveInboxEdit(event) {
  const el = event.target,
    form = el.closest('[data-inbox]');
  if (!form || !el.name || ['file', 'password'].includes(el.type)) return;
  const q = state?.jobs
    .find((j) => j.id === form.dataset.inbox)
    ?.autonomy?.inbox?.items.find((q) => q.id === el.name);
  if (
    (!q && el.name !== '__manual_quiz') ||
    /인증\s*문자|보안\s*문자|자동\s*(?:기입|입력)\s*방지|captcha|verification code/i.test(
      `${q?.label || ''} ${q?.description || ''}`,
    )
  )
    return;
  const answers = readInboxEdits(form);
  answers[el.name] = [...form.elements]
    .filter((e) => e.name === el.name && (!['checkbox', 'radio'].includes(e.type) || e.checked))
    .map((e) => e.value);
  try {
    sessionStorage.setItem(inboxStorageKey(form), JSON.stringify({ at: Date.now(), answers }));
  } catch {}
  syncInboxConditions(form);
  syncManualQuiz(form);
}
document.addEventListener('input', saveInboxEdit);
document.addEventListener('change', saveInboxEdit);
function renderReceiptCheck(check) {
  if (!check) return '';
  const labels = {
    accepted: '접수 확인',
    rejected: '오류·거절 안내',
    existing: '기존 참여 안내',
    pending: '처리 중·대기',
    conflict: '서로 다른 결과',
    unconfirmed: '접수 미확인',
  };
  return `<details class="receipt-check"><summary>제출 결과 판정 · ${esc(check.captureIncomplete ? '접수 관찰 오류' : labels[check.outcome] || '미확인')}</summary><p>${esc(check.reason)}</p><p class="hint">${check.method === 'ai' ? 'AI 의미 검토' : '명확한 규칙으로 판정'} · ${esc(new Date(check.at).toLocaleString('ko-KR'))}</p>${check.signals.map((s) => `<div class="notification-note"><strong>${esc({ response: '서버 응답', dialog: '브라우저 알림', page: '화면' }[s.kind])} · ${esc(labels[s.outcome] || '미확인')}</strong>${s.status ? `<p>HTTP ${esc(s.status)}</p>` : ''}${s.bodyState && s.bodyState !== 'parsed' ? `<p>응답 본문: ${esc({ reading: '읽는 중', unsupported: '지원하지 않는 형식', too_large: '보관 크기 초과', unavailable: '읽기 실패 · 상태 코드만 기록' }[s.bodyState] || s.bodyState)}</p>` : ''}${s.codes?.length ? `<p>응답 코드: ${s.codes.map(esc).join(', ')}</p>` : ''}${s.flags?.length ? `<p>결과 플래그: ${s.flags.map(esc).join(', ')}</p>` : ''}${s.contract === 'naver-form-answer' ? '<p>네이버 폼의 해당 설문 답변 저장 응답으로 확인</p>' : ''}${s.receiptNumbers?.length ? `<p>접수번호: ${s.receiptNumbers.map(esc).join(', ')}</p>` : ''}${s.message ? `<blockquote>${esc(s.message)}</blockquote>` : ''}</div>`).join('')}${renderReceiptCapture(check.capture)}</details>`;
}
function renderReceiptCapture(capture) {
  if (!capture) return '';
  const reasons = {
    unrecognized_destination: '제출 대상과 다른 요청',
    unrelated_tab: '작업과 무관한 탭',
    subframe: '하위 프레임',
    service_worker: '탭 연결을 확인할 수 없는 서비스 워커',
    frame_unavailable: '요청 탭 확인 불가',
    unsupported_request_type: '지원하지 않는 요청 종류',
    insufficient_values: '승인 답변의 연결 근거 부족',
    unsupported_body: '지원하지 않거나 큰 요청 형식',
    payload_mismatch: '승인 답변과 불일치',
    request_limit: '관찰 요청 한도 초과',
    observation_error: '응답 관찰 오류',
  };
  return `<details><summary>네트워크 수집 진단</summary><p>관찰한 POST ${capture.observedPosts}개 · 승인 제출과 연결 ${capture.matchedRequests}개 · 응답 기록 ${capture.responses}개${capture.failedRequests ? ` · 네트워크 실패 관측 ${capture.failedRequests}개` : ''}</p><p>새 탭 ${capture.popups}개 · 화면 이동 ${capture.navigations}회${capture.pageClosed ? ' · 창 닫힘 관측' : ''}</p>${capture.responses ? '' : '<p>연결된 서버 응답이 없어 화면·알림 근거만으로 판정했습니다.</p>'}${
    Object.keys(capture.rejected).length
      ? `<ul>${Object.entries(capture.rejected)
          .map(([reason, count]) => `<li>${esc(reasons[reason] || reason)}: ${count}개</li>`)
          .join('')}</ul>`
      : ''
  }${(capture.bindingChecks || []).length ? `<ul>${capture.bindingChecks.map((check) => `<li>${esc(check.encoding)} · 답변 ${check.expected}개 중 ${check.matched}개 연결${check.phoneFormatting ? ` · 같은 전화번호 서식 보정 ${check.phoneFormatting}개` : ''}${check.unmatchedPhone || check.unmatchedText ? ` · 불일치: 전화번호 ${check.unmatchedPhone}개 / 기타 답변 ${check.unmatchedText}개` : ''}</li>`).join('')}</ul>` : ''}</details>`;
}
function renderFormExecution(j) {
  const f = j.formExecution;
  if (!f) return '';
  const input =
    { applying: '입력 검증 중', verified: '입력 검증 완료' }[f.input?.state] ||
    '현재 페이지 관찰·답변 준비';
  const next =
    { observing: '이동 결과 관찰 중', blocked: '이동 결과 관찰 대기', verified: '이동 확인 완료' }[
      f.transition?.state
    ] || '이동 전';
  const final =
    {
      review: '최종 제출 승인 대기',
      observing: '최종 접수 판정 중',
      accepted: '접수 완료',
      unconfirmed: '접수 미확인',
    }[f.submission?.state] || '최종 제출 전';
  return `<div class="form-execution"><strong>폼 진행 단계</strong><p>입력 · ${esc(input)}${f.input ? ` (${f.input.fields}개)` : ''}<br>페이지 전환 · ${esc(next)} (${f.pages.length}회 확인)<br>최종 제출 · ${esc(final)}</p>${f.pages.length ? `<details><summary>페이지 전환 근거</summary><ol>${f.pages.map((p) => `<li>${esc(p.reason)} · 관찰 ${p.attempts}회 · 연결 요청 ${p.requests}건${p.statuses.length ? ` · HTTP ${p.statuses.map(esc).join(', ')}` : ''}</li>`).join('')}</ol></details>` : ''}</div>`;
}
function renderOutcome(j) {
  if (!j.uncertain && !j.holdNote && !j.archivedAt) return '';
  return `<div class="outcome-note">${j.archivedAt ? '<strong>보관한 작업 · 자동 실행 안 함</strong>' : ''}${j.uncertain ? '<strong>접수 결과 미확인 · 재응모 잠금 유지</strong><p>완료나 실패가 확정된 상태가 아닙니다. 중복 제출을 막기 위해 자동 재시도하지 않습니다.</p>' : ''}${j.holdNote ? `<p class="consent-notice">${esc(j.holdNote)}</p>` : ''}${j.uncertain ? '<p class="hint">접수 증거를 다시 확인하거나, 실제 미제출을 확인한 뒤 현재 화면에서 이어갈 수 있습니다. 이어갈 화면이 없다면 미확인 상태로 보관할 수 있습니다.</p>' : ''}</div>`;
}
function renderJobBudget(j) {
  const b = j.budget;
  const progress = j.autonomy?.researchProgress;
  const research = progress?.calls || progress?.stops?.length ? progress : undefined;
  const stop = research?.stops?.at(-1)?.code;
  const researchReason =
    {
      research_budget_reserved: '입력·검토에 필요한 판단 횟수를 남기고 조사를 중단했습니다.',
      research_allocation_used: '이 문항에 배분한 조사 횟수를 사용했습니다.',
      research_repeated_query: '같거나 유사한 검색 반복을 중단했습니다.',
      research_map_unavailable: '관찰한 공식 지도로 전환했지만 조회 화면을 열지 못했습니다.',
      research_no_progress: '같은 화면에서 새 근거가 없어 조사를 중단했습니다.',
      research_rejection_limit: '읽기 차단·실패 주소 등으로 재계획한 뒤에도 진행하지 못했습니다.',
      research_engine_switch_limit: '검색 엔진 사이의 반복 전환을 중단했습니다.',
      research_action_not_read_only: '조회 범위를 벗어나는 동작을 실행하지 않았습니다.',
      research_controls_or_evidence_unavailable:
        '현재 조회 컨트롤 또는 공개 정답 근거가 부족합니다.',
      research_evidence_review: '관찰한 근거를 답변 준비 단계에서 검증합니다.',
    }[stop] ||
    (stop
      ? '공개 근거 조사를 중단했습니다. 실행 기록에서 원인을 확인하세요.'
      : '공개 근거를 조사하고 있습니다.');
  return `<div class="job-meta">${b ? `AI 호출 ${b.calls}/${b.callLimit}회 · 이 작업 남은 판단 최대 ${b.remainingDecisions}회<br>` : ''}판단 ${j.steps}/${j.maxSteps}회 · 입력 ${j.inputTokens.toLocaleString()} / 출력 ${j.outputTokens.toLocaleString()} 토큰</div>${research ? `<p class="hint"><strong>공개 정답 조사 · ${research.calls}회</strong><br>${esc(researchReason)}${j.autonomy?.researchBudget ? `<br>공개 조사 남은 배정 ${j.autonomy.researchBudget.remaining}회 · 입력·검토 예약 ${j.autonomy.researchBudget.reserve}회` : ''}${research.controlReobservations ? `<br>조회 컨트롤 자동 재관찰 ${research.controlReobservations}회` : ''} 아직 확인하지 못한 정답은 추측해 제출하지 않습니다.</p>` : ''}${b?.blocked ? `<p class="warning-text">${b.blocked === 'selection_call_limit' ? `운영 설정의 호출 한도 ${b.callLimit}회 소진` : '운영 설정의 토큰 한도 소진'} · 작업 한도 ${j.maxSteps}회와 별도로 적용됩니다. 같은 설정으로는 추가 AI 판단을 실행할 수 없습니다.</p>` : ''}`;
}
function renderDiscoveryBudgetHint() {
  if (!state?.selectionPolicy) return;
  const requested = Number($('step-limit').value),
    policy = state.selectionPolicy.discoveryCalls;
  $('discovery-budget-hint').textContent =
    `실제 탐색 상한: 최대 ${Math.min(requested, policy)}회 · 이 화면 ${requested}회 / 운영 설정 ${policy}회 중 먼저 도달하는 한도가 적용됩니다. 하루 사용량 한도도 적용됩니다.`;
}
function renderJobActions(j) {
  const budgetBlocked = j.kind === 'discover' && !!j.budget?.blocked;
  const b = (action, label, disabled = false) =>
    `<button data-action="${action}" data-job="${j.id}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  if (j.archivedAt)
    return `<div class="card-actions">${b('unarchive', '진행 목록으로 복원', state.busy)}</div>`;
  if (j.status === 'running')
    return `<div class="card-actions">${b('pause', '일시정지 · 직접 조작')}${b('stop', '중지')}</div>`;
  if (['completed', 'stopped'].includes(j.status)) return '';
  if (delegationIssue(j))
    return `<div class="card-actions">${b('archive', '진행 목록에서 보관', state.busy)}</div>`;
  return `<div class="card-actions">${j.status === 'approval' ? b('pause', '취소 · 직접 조작') : j.autonomy?.inbox ? '' : b('resume', budgetBlocked ? '운영 한도 소진 · 재개 불가' : j.steps >= j.maxSteps ? '20회 추가해 재개' : j.kind === 'discover' ? `남은 최대 ${j.budget?.remainingDecisions ?? j.maxSteps - j.steps}회로 탐색 재개` : '새 화면에서 재개', state.busy || budgetBlocked)}${['paused', 'failed', 'needs_user', 'submission_unknown'].includes(j.status) ? b('resume-current', '현재 브라우저 화면에서 재개', state.busy || budgetBlocked) : ''}${j.uncertain ? b('verify-result', '저장된 접수 증거 다시 확인', state.busy) + b('reconcile', '미제출 직접 확인', state.busy) : ''}${b('archive', j.uncertain ? '미확인 상태로 보관' : '진행 목록에서 보관', state.busy)}</div>`;
}
function render() {
  renderDiscoveryBudgetHint();
  if (initial && !state.autonomy.policy.enabled) $('prepare-one').checked = false;
  if (lastInboxAction) {
    const j = state.jobs.find((j) => j.id === lastInboxAction.id);
    if (j && ['stopped', 'failed', 'completed', 'submission_unknown'].includes(j.status)) {
      toast(`방금 처리한 응모: ${jobNote(j)}`, j.status !== 'completed');
      lastInboxAction = undefined;
    }
  }
  renderSelection();
  renderOperations();
  renderOutcomeSummary();
  renderTelegramAndInbox();
  $('result-attention').innerHTML =
    state.outcomeAlerts?.length || $('dm-reviews').textContent.trim()
      ? '<p class="hint">당첨·경품 관련 확인은 <a href="#rewards">08 · 결과·경품 알림함</a>에서 볼 수 있습니다.</p>'
      : '';
  const auth = state.auth;
  if (state.browser) {
    if (renderedBrowserEngine !== state.browser.engine) {
      $('browser-engine').value = state.browser.engine;
      renderedBrowserEngine = state.browser.engine;
    }
    $('browser-status').textContent =
      `${state.browser.profile} · ${state.browser.open ? '열림' : '닫힘'} · ${state.browser.manual ? '직접 조작' : '에이전트 실행 중'}`;
  }
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
  $('saved-answers').innerHTML = state.autonomy.savedAnswers.length
    ? state.autonomy.savedAnswers
        .map(
          (a) =>
            `<p>${esc(a.question)} · ${esc(a.origin)} <button data-forget="${a.id}">삭제</button></p>`,
        )
        .join('')
    : '<p class="hint">확인함에서 재사용을 선택한 답변이 여기에 표시됩니다.</p>';
  const contentKey = JSON.stringify({
    events: state.events,
    entryBatch: state.entryBatch,
    entryBatchKey: state.entryBatchPlan?.key,
    jobs: state.jobs,
    busy: state.busy,
    autonomyRevision: state.autonomy.revision,
    completedEntries: state.completedEntries,
    outcomes: state.outcomes,
  });
  const focusedTask = document.activeElement?.closest('[data-task-review]')?.dataset.taskReview;
  if (
    focusedTask &&
    state.jobs.some(
      (j) =>
        j.id === focusedTask &&
        !j.archivedAt &&
        j.status === 'needs_user' &&
        !j.autonomy?.inbox &&
        j.tasks?.some((t) => t.state === 'review'),
    )
  )
    return;
  if (contentKey === rendered) return;
  rendered = contentKey;
  renderCompleted();
  renderEvents();
  if (
    state.jobs.some(
      (j) =>
        canAnswerInbox(j) &&
        j.autonomy.inbox.id === document.activeElement?.closest('[data-inbox]')?.dataset.inboxId,
    )
  ) {
    rendered = '';
    return;
  }
  const cards = state.jobs.length
    ? state.jobs.map(
        (j) =>
          `<article data-activity-job="${esc(j.id)}" class="job" id="job-${esc(j.id)}"><div class="section-head"><div><span class="pill ${j.status === 'running' ? 'active' : j.status === 'submission_unknown' ? 'warning' : ''}">${esc(j.notice ? { normal: '정상 중단', technical: '기술 오류', user: '사용자 확인 필요' }[j.notice.category] : statuses[j.status])}</span><h3>${esc({ result: '당첨 발표 확인', discover: '이벤트 탐색', apply: '이벤트 응모', demo: '합성 화면 테스트', autonomy_demo: '자율 설문 테스트' }[j.kind])}</h3></div><small>${esc(j.provider.kind === 'chatgpt' ? 'ChatGPT 플랜' : 'OpenAI API')} · ${esc(j.provider.model)}</small></div>${j.eventId ? `<p class="job-event-title">${esc(state.events.find((e) => e.id === j.eventId)?.title || '')}</p>` : ''}<p>${esc(j.notice?.reason || jobNote(j))}</p>${renderJobNotice(j)}${renderFormExecution(j)}${renderOutcome(j)}${renderReceiptCheck(j.receiptCheck)}${renderJobBudget(j)}${j.discoveryStart ? `<p class="hint">시작 전략 · ${esc(j.discoveryStart.reason)}${j.discoveryStart.query ? `<br>검색어: ${esc(j.discoveryStart.query)}` : ''}</p>` : ''}${j.kind === 'discover' ? `<div class="job-meta">자동 출처 전환 ${j.discovery?.switches || 0}/${j.discovery?.switchLimit ?? 6}회</div>` : ''}${renderReadTraces(j)}${renderTasks(j)}${renderInbox(j)}${j.approval && j.status === 'approval' && !j.archivedAt ? `<div class="approval"><strong>${j.approval.kind === 'content' ? '입력 내용 확인' : '외부 동작 확인'}</strong><p>${esc(j.approval.url)}</p><p>대상: ${esc(j.approval.target?.label || '화면의 선택 좌표')} ${j.approval.target?.href ? safeLink(j.approval.target.href, '이동 주소') : ''}</p><p>동작: ${esc(j.approval.action.action)} · ${esc(j.approval.action.reason)}</p>${j.approval.action.text ? `<pre>${esc(j.approval.action.text)}</pre>` : ''}${renderFormReview(j.approval.form, j.approval.url)}<p class="hint">이 내용과 현재 화면에 한해 허용됩니다. 화면이 바뀌면 다시 확인합니다.</p><button class="primary" data-action="approve" data-job="${j.id}" data-approval="${j.approval.id}">확인한 동작 실행</button></div>` : ''}<details class="evidence"><summary>관찰 화면과 실행 내역</summary>${j.screenshot ? `<a href="/evidence/${esc(j.screenshot)}" target="_blank"><img loading="lazy" src="/evidence/${esc(j.screenshot)}" alt="이 작업의 최근 브라우저 관찰 화면"></a>` : '<p>아직 관찰 화면이 없습니다.</p>'}<ol>${j.history.map((h) => `<li>${esc(h.reason)} <small>${esc(h.action)}</small></li>`).join('')}</ol></details>${!j.autonomy && !j.archivedAt && j.notice?.category === 'user' && !j.uncertain && ['needs_user', 'paused'].includes(j.status) ? `<details><summary>내 답변 전달하기</summary><form data-job-context="${esc(j.id)}"><p class="hint">현재 질문에 대한 실제 답을 적어주세요. 비밀번호·연락처는 전용 브라우저에 직접 입력하세요.</p><textarea name="text" required maxlength="2000" placeholder="질문과 답변을 함께 적어주세요."></textarea><button type="submit">답변 저장 후 재개</button></form></details>` : ''}${renderJobActions(j)}</article>`,
      )
    : [];
  const active = (j) => !j.archivedAt && !terminalJob(j);
  $('pending-count').textContent = state.jobs.filter(
    (j) =>
      active(j) &&
      ['paused', 'failed', 'needs_user', 'approval', 'submission_unknown'].includes(j.status),
  ).length;
  $('active-jobs').innerHTML =
    cards.filter((_, i) => active(state.jobs[i])).join('') ||
    '<div class="empty compact">지금 확인할 일이 없습니다.</div>';
  $('jobs').innerHTML =
    cards.filter((_, i) => !active(state.jobs[i])).join('') ||
    '<div class="empty compact">지난 실행 기록이 여기에 쌓입니다.</div>';
  updateActiveJobVisibility();
  restoreInboxEdits();
}
async function refresh() {
  try {
    state = await api('/api/state');
  } catch (error) {
    throw new Error(`서버 상태를 불러오지 못했습니다. ${error.message}`);
  }
  try {
    render();
  } catch (error) {
    throw new Error(`대시보드를 표시하지 못했습니다. ${error.message}`);
  }
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
$('step-limit').onchange = renderDiscoveryBudgetHint;
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
$('browser-settings-form').onsubmit = guard(async () => {
  await api('/api/browser/settings', { engine: $('browser-engine').value });
  toast('선택한 전용 브라우저를 적용했습니다. 서비스 버튼에서 로그인 상태를 확인해 주세요.');
});
$('browser-close').onclick = guard(async () => {
  await api('/api/browser/close', {});
  toast(
    '전용 브라우저를 정상 종료했습니다. 같은 브라우저를 다시 열면 저장된 사이트 데이터가 재사용됩니다.',
  );
});
$('browser-check').onclick = guard(async () => {
  const result = await api('/api/browser/check', {});
  $('browser-check-result').textContent = result.message;
});
$('discover-form').onsubmit = guard(async () => {
  await api('/api/jobs', {
    kind: 'discover',
    discoverySource: $('discovery-source').value,
    sourceUrl: $('discovery-source').value === 'custom' ? $('source-url').value : undefined,
    provider: requireChoice(),
    goal: $('goal').value,
    candidateLimit: Number($('candidate-limit').value),
    prepareOne: $('prepare-one').checked,
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
for (const id of ['autonomy-demo', 'autonomy-demo-inbox'])
  $(id).onclick = guard(async () => {
    await api('/api/jobs', {
      kind: 'autonomy_demo',
      provider: requireChoice(),
      goal: '합성 프로필과 위임 기준으로 이 설문을 완료하고 실제 접수 결과를 확인하세요.',
      maxSteps: 20,
      layout: id.endsWith('inbox') ? 'shift' : 'normal',
      demoInbox: id.endsWith('inbox'),
    });
    toast('가상 정보와 위임 정책으로 자율 설문을 시작했습니다. 실제 프로필은 사용하지 않습니다.');
  });
async function loadProfile() {
  const value = await api('/api/autonomy');
  const form = $('autonomy-form');
  for (const [key, v] of Object.entries({ ...value.profile, ...value.policy })) {
    const el = form.elements.namedItem(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v;
    else el.value = v;
  }
  const c = value.policy.consent || {
    mode: 'manual',
    fields: ['name', 'email', 'phone'],
    extraFields: ['nickname', 'interest', 'entryChannel'],
    maxRetentionDays: 31,
    allowThirdParty: false,
    recipients: [],
    declineOptional: true,
    blockedRequired: 'ask',
  };
  form.elements.namedItem('consentMode').value = c.mode;
  for (const el of form.querySelectorAll('[name="consentFields"]'))
    el.checked = c.fields.includes(el.value);
  for (const el of form.querySelectorAll('[name="consentExtraFields"]'))
    el.checked = c.extraFields.includes(el.value);
  form.elements.namedItem('consentRetention').value = c.maxRetentionDays;
  form.elements.namedItem('consentThirdParty').checked = c.allowThirdParty;
  form.elements.namedItem('consentRecipients').value = c.recipients.join('\n');
  form.elements.namedItem('consentDeclineOptional').checked = c.declineOptional;
  form.elements.namedItem('consentBlocked').value = c.blockedRequired;
  renderConsentSettings();
}
function renderConsentSettings() {
  const mode = $('autonomy-form').elements.namedItem('consentMode').value;
  $('consent-auto-controls').hidden = mode === 'manual';
  $('consent-adaptive-controls').hidden = mode !== 'adaptive';
}
$('autonomy-form').addEventListener('change', renderConsentSettings);
const qualForm = $('qualification-profile');
async function loadQualifications() {
  const p = await api('/api/qualification-profile');
  for (const key of ['adult', 'instagram', 'publicAccount', 'eventAccount'])
    qualForm.elements[key].value = p[key];
  qualForm.elements.services.value = p.services.join('\n');
  qualForm.querySelector('button[type=submit]').disabled = false;
}
void loadQualifications().catch(() => {
  $('qualification-status').textContent =
    '참가 자격을 불러오지 못했습니다. 대시보드를 새로고침하세요.';
});
qualForm.onsubmit = guard(async () => {
  const data = Object.fromEntries(new FormData(qualForm));
  data.services = [
    ...new Set(
      data.services
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  await api('/api/qualification-profile', data);
  $('qualification-status').textContent = '저장했습니다. 수집한 기회의 현재 조건에 반영됩니다.';
});
document.addEventListener('click', (ev) => {
  const id = ev.target.closest('[data-qualification-event]')?.dataset.qualificationEvent;
  if (!id) return;
  const e = state.events.find((e) => e.id === id);
  const checks =
    e?.assessment?.conditions.filter((c) => c.scope === 'event' || c.kind === 'service') || [];
  if (!checks.length) return;
  const form = $('qualification-answers');
  form.dataset.event = id;
  $('qualification-error').textContent = '';
  $('qualification-event-name').textContent = e.title;
  $('qualification-items').innerHTML = checks
    .map(
      (
        c,
      ) => `<label>${esc(c.label)}${c.account ? ' · @' + esc(c.account) : ''} <small>${esc(c.quote)}</small>
    ${c.needsAccount ? '<span>프로필에서 참여용 인스타 아이디를 먼저 저장하세요.</span>' : ''}
    <select name="${esc(c.id)}" ${c.needsAccount ? 'disabled' : ''}>${Object.entries({
      unknown: c.kind === 'service' ? '행사별 답변 없음 · 프로필 기준' : '미확인',
      yes: '해당함',
      no: '해당하지 않음',
    })
      .map(
        ([v, t]) =>
          `<option value="${v}" ${v === (c.scope === 'profile' ? 'unknown' : c.value) ? 'selected' : ''}>${t}</option>`,
      )
      .join('')}</select></label>`,
    )
    .join('');
  form.querySelector('[type=submit]').disabled = !checks.some((c) => !c.needsAccount);
  $('qualification-dialog').showModal();
});
$('qualification-answers').onsubmit = guard(async () => {
  const form = $('qualification-answers');
  try {
    await api(`/api/events/${form.dataset.event}/qualifications`, {
      answers: [...new FormData(form)].map(([id, value]) => ({ id, value })),
    });
  } catch (err) {
    $('qualification-error').textContent =
      '저장하지 못했습니다. 창을 닫고 최신 참가 조건을 확인하세요.';
    throw err;
  }
  $('qualification-dialog').close();
  toast('이 행사의 참가 자격을 저장했습니다.');
});
$('reload-profile').onclick = guard(loadProfile);
void loadProfile().catch((error) => toast(error.message, true));
$('autonomy-form').onsubmit = guard(async () => {
  const f = new FormData($('autonomy-form'));
  const profile = Object.fromEntries(
    [
      'name',
      'email',
      'phone',
      'region',
      'occupation',
      'ageRange',
      'shippingAddress',
      'shippingAddressDetail',
      'postalCode',
    ].map((k) => [k, String(f.get(k) || '')]),
  );
  const policy = {
    enabled: f.has('enabled'),
    autoRecommendations: f.has('autoRecommendations'),
    semanticPreferenceReuse: f.has('semanticPreferenceReuse'),
    preferenceRule: f.get('preferenceRule'),
    evaluationRule: f.get('evaluationRule'),
    singleChoice: f.get('singleChoice'),
    finalSubmit: f.get('finalSubmit'),
    maxRecoveries: Number(f.get('maxRecoveries')),
    consent: {
      mode: f.get('consentMode'),
      fields: f.getAll('consentFields'),
      extraFields: f.getAll('consentExtraFields'),
      maxRetentionDays: Number(f.get('consentRetention')),
      allowThirdParty: f.has('consentThirdParty'),
      recipients: String(f.get('consentRecipients') || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      declineOptional: f.has('consentDeclineOptional'),
      blockedRequired: f.get('consentBlocked'),
    },
  };
  await api('/api/autonomy', { profile, policy });
  toast('저장했습니다. 새 응모부터 적용합니다.');
});
const handleAutonomyClick = guard(async (event) => {
  const external = event.target.closest('[data-external]');
  if (external) {
    await api('/api/browser/external', { url: external.dataset.external });
    toast('일반 브라우저에서 직접 진행하세요. 이 창의 로그인은 에이전트와 공유되지 않습니다.');
  }
  const login = event.target.closest('[data-login]');
  if (login) {
    await api('/api/browser/open', { url: login.dataset.login });
    toast('전용 브라우저에서 로그인해 주세요. 세션은 다음 작업에도 재사용합니다.');
  }
  const forget = event.target.closest('[data-forget]');
  if (forget) await api('/api/answers/delete', { id: forget.dataset.forget });
  const reviewConsent = event.target.closest('[data-review-consent]');
  if (reviewConsent) {
    await api(`/api/jobs/${reviewConsent.dataset.reviewConsent}/review-consent`, {});
    toast('다른 답변을 유지하고 동의 선택만 다시 검토합니다.');
  }
  const restore = event.target.closest('[data-restore-form]');
  if (restore) {
    if (
      !confirm(
        '이 폼을 직접 제출한 적이 없습니까? 확인하면 입력 전 화면만 다시 열고, 기존 답변 확인함은 유지합니다. 이미 제출했다면 취소해 주세요.',
      )
    )
      return;
    await api(`/api/jobs/${restore.dataset.restoreForm}/restore-form`, {
      confirmedNotSubmitted: true,
    });
    toast('입력 전 화면을 복원했습니다. 기존 확인함에서 계속할 수 있습니다.');
  }
  const prepare = event.target.closest('[data-prepare-drafts]');
  if (prepare) {
    const box = state.jobs.find((j) => j.id === prepare.dataset.prepareDrafts)?.autonomy?.inbox;
    await api(`/api/jobs/${prepare.dataset.prepareDrafts}/prepare-drafts`, { inboxId: box.id });
    prepare.blur();
    toast('서술형 초안을 준비합니다. 입력 중인 답변은 유지합니다.');
  }
  const recommend = event.target.closest('[data-recommend]');
  if (recommend) {
    const box = state.jobs.find((j) => j.id === recommend.dataset.recommend).autonomy.inbox;
    const form = recommend.closest('form');
    for (const q of box.items.filter((q) => q.recommended)) {
      let rankIndex = 0;
      for (const el of form.elements) {
        if (el.name !== q.id || savedInboxValue(form, q.id) !== undefined) continue;
        if (el.type === 'checkbox' || el.type === 'radio')
          el.checked = q.recommended.includes(el.value);
        else el.value = q.recommended[q.kind === 'rank' ? rankIndex++ : 0] || '';
      }
      const first = [...form.elements].find((el) => el.name === q.id);
      if (first) saveInboxEdit({ target: first });
    }
    syncInboxConditions(form);
  }
});
document.addEventListener('click', (event) => {
  if (
    event.target.closest(
      '[data-login],[data-forget],[data-recommend],[data-prepare-drafts],[data-restore-form],[data-review-consent],[data-external]',
    )
  )
    void handleAutonomyClick(event);
});
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!form.matches('[data-inbox]')) return;
  void guard(async () => {
    const box = state.jobs.find((j) => j.id === form.dataset.inbox).autonomy.inbox;
    const f = new FormData(form);
    const answers = Object.fromEntries(
      box.items.filter((q) => q.kind !== 'file').map((q) => [q.id, f.getAll(q.id)]),
    );
    for (const q of box.items.filter((q) => q.multiple && q.kind !== 'file')) {
      const count = (answers[q.id] || []).length;
      if (
        (q.minChoices && count < q.minChoices && (q.required || count > 0)) ||
        (q.maxChoices && count > q.maxChoices)
      )
        throw new Error(
          `${q.label}: ${q.minChoices === q.maxChoices ? `정확히 ${q.maxChoices}개` : `최대 ${q.maxChoices}개`}를 선택해 주세요.`,
        );
    }
    const explicitDeclines = [];
    for (const q of box.items)
      if (
        q.category === 'consent' &&
        q.kind === 'checkbox' &&
        q.options.length === 1 &&
        answers[q.id]?.includes('__ssal_decline__')
      ) {
        answers[q.id] = [];
        explicitDeclines.push(q.id);
      }
    for (const q of box.items.filter((q) => q.kind === 'file')) {
      const file = f.get(q.id),
        driveName = f.get(`drive-${q.id}`)?.trim();
      if (driveName) {
        if (file?.size) throw new Error('기기 파일 또는 Drive 파일 중 하나만 선택해 주세요.');
        if (!f.has(`upload-${q.id}`))
          throw new Error('Drive와 주최자에게 파일 전달을 허용해 주세요.');
        const saved = await api('/api/drive-selection', {
          jobId: form.dataset.inbox,
          questionId: q.id,
          name: driveName,
          allowPicker: true,
        });
        answers[q.id] = [saved.id];
        continue;
      }
      if (!file?.size && q.proofAttachment && f.has(`upload-${q.id}`)) {
        const saved = await api('/api/attachments/proof', {
          jobId: form.dataset.inbox,
          inboxId: form.dataset.inboxId,
          questionId: q.id,
          sha256: q.proofAttachment.sha256,
          allowUpload: true,
          allowPicker: !!q.picker,
        });
        answers[q.id] = [saved.id];
        continue;
      }
      if (!file?.size) {
        answers[q.id] = [];
        continue;
      }
      if (file.size > 5 * 1024 * 1024) throw new Error('첨부는 최대 5MB입니다.');
      if (!f.has(`upload-${q.id}`))
        throw new Error('파일을 이 주최자에게 첨부하는 데 동의해 주세요.');
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const saved = await api('/api/attachments', {
        jobId: form.dataset.inbox,
        questionId: q.id,
        name: file.name,
        base64,
        allowUpload: true,
        allowPicker: !!q.picker,
      });
      answers[q.id] = [saved.id];
    }
    await api(`/api/jobs/${form.dataset.inbox}/inbox`, {
      inboxId: form.dataset.inboxId,
      confirm: box.final,
      answers,
      remember: f.has('remember'),
      explicitDeclines,
    });
    lastInboxAction = { id: form.dataset.inbox, at: Date.now() };
    sessionStorage.removeItem(inboxStorageKey(form));
    toast('답변을 전달했습니다. 현재 화면에서 이어서 진행합니다.');
  })(event);
});
const handleAction = guard(async (event) => {
  const apply = event.target.closest('[data-apply]');
  if (apply) {
    const e = state.events.find((e) => e.id === apply.dataset.apply);
    const provider = requireChoice();
    if (
      !confirm(
        `${e.title}\n\n원문에서 참여 자격과 브라우저 대행이 가능한 범위를 확인했나요?\n필수 과제: ${e.requirements.join(' / ')}\n\n${state.autonomy.policy.enabled ? '저장한 프로필과 위임 정책으로 이 사이트에서 진행합니다. 최종 제출: ' + (state.autonomy.policy.finalSubmit === 'auto' ? '자동' : '확인함에서 확인') : '응모 준비를 시작하며, 새 입력 내용과 게시·제출은 따로 확인합니다.'}`,
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
      autonomy: state.autonomy.policy.enabled,
    });
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, job: id, approval: approvalId } = button.dataset;
  const job = state.jobs.find((j) => j.id === id);
  if (action === 'renew-resume-current' || action === 'delegation') {
    if (
      !confirm(
        `${state.events.find((e) => e.id === job.eventId)?.title || '이 작업'}\n대상: ${job.autonomy.origin}\n\n현재 저장된 프로필·위임 정책을 이 작업에 24시간 적용합니다.\n최종 제출: ${state.autonomy.policy.finalSubmit === 'auto' ? '자동' : '확인함에서 직접 확인'}\n사용량·복구 횟수와 접수 기록은 유지합니다. 현재 화면에서 이어갈까요?`,
      )
    )
      return;
    await api(`/api/jobs/${id}/renew-delegation`, {
      revision: state.autonomy.revision,
      useCurrentPage: true,
    });
    toast('위임을 갱신했습니다. 현재 화면에서 이어서 진행합니다.');
    return;
  }
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
    toast(error.message, true);
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

$('completed-search').addEventListener('input', () => {
  completedLimit = 20;
  renderCompleted();
});
for (const id of ['event-filter', 'event-sort', 'event-search'])
  $(id).addEventListener(id === 'event-search' ? 'input' : 'change', () => {
    eventLimit = 20;
    renderEvents();
  });
$('events-more').onclick = () => {
  eventLimit += 20;
  renderEvents();
};
$('events-collapse').onclick = () => {
  eventLimit = 20;
  renderEvents();
};
$('completed-more').onclick = () => {
  completedLimit += 20;
  renderCompleted();
};
$('completed-collapse').onclick = () => {
  completedLimit = 20;
  renderCompleted();
};

let operationsLoaded = false;
let storageLoaded = false;
let storageLoading = false;
let storageReport;
const storageSize = (bytes) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
async function refreshStorage() {
  const s = await api('/api/storage');
  storageReport = s;
  if (!storageLoaded) {
    for (const [key, value] of Object.entries(s.config)) {
      const el = $('storage-form').elements[key];
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
    }
    storageLoaded = true;
  }
  $('storage-summary').innerHTML =
    `<p><strong>스크린샷 ${storageSize(s.screenshotBytes)} / ${storageSize(s.config.screenshotLimitMiB * 1024 ** 2)}</strong> · ${s.screenshotCount.toLocaleString()}장</p>
    <p>보호 자료 ${storageSize(s.protectedBytes)} · 관찰 JSON ${storageSize(s.traceBytes)} · 정리 예정 ${s.plannedCount}장 (${storageSize(s.plannedBytes)})</p>
    ${s.cleanupError ? '<p class="warning-text">최근 자동 정리 중 파일 접근 오류가 있었습니다. 정리 결과를 확인하고 다시 시도해 주세요.</p>' : ''}
    ${s.limitBlocked ? '<p class="warning-text">보호 자료 때문에 상한을 확보할 수 없습니다. 중요한 자료는 자동 삭제하지 않으며 새 관찰이 중단될 수 있습니다.</p>' : ''}
    <details><summary>보호 이유·정리 예정 내역</summary><ul>${s.protection.map((p) => `<li>${esc(p.reason)}: ${p.count}장 · ${storageSize(p.bytes)}</li>`).join('')}</ul>
    <ul>${s.planned.map((p) => `<li>${esc(new Date(p.at).toLocaleString('ko-KR'))} · ${esc(p.reason)} · ${storageSize(p.bytes)}<small> ${esc(p.name)}</small></li>`).join('') || '<li>지금 정리할 일반 자료가 없습니다.</li>'}</ul>${s.plannedCount > 20 ? '<p>오래된 순서로 처음 20개만 표시합니다.</p>' : ''}</details>
    <p>${s.caches.map((c) => `${c.profile === 'browser' ? 'Chromium' : 'Chrome'} 캐시 ${storageSize(c.bytes)}${c.open ? ' · 열림, 정리 보류' : ' · 닫힘'}`).join('<br>')}</p>
    ${s.lastCleanup ? `<p class="hint">최근 관찰 정리: ${esc(new Date(s.lastCleanup.at).toLocaleString('ko-KR'))} · ${s.lastCleanup.files}개 파일 · ${storageSize(s.lastCleanup.bytes)}</p>` : ''}
    ${s.lastCacheCleanup ? `<p class="hint">최근 캐시 정리: ${esc(new Date(s.lastCacheCleanup.at).toLocaleString('ko-KR'))} · ${storageSize(s.lastCacheCleanup.bytes)}</p>` : ''}
    <p class="hint">확인 시각 ${esc(new Date(s.at).toLocaleString('ko-KR'))} · 파일 크기 기준이며 DB·첨부·브라우저 전체 용량은 스크린샷 상한에 포함되지 않습니다.</p>`;
  $('storage-cleanup').disabled = !!state?.busy;
}
$('storage-refresh').onclick = guard(refreshStorage);
$('storage-form').onsubmit = guard(async () => {
  const f = new FormData($('storage-form'));
  await api('/api/storage', {
    automatic: f.has('automatic'),
    retentionDays: Number(f.get('retentionDays')),
    screenshotLimitMiB: Number(f.get('screenshotLimitMiB')),
    cacheCleanup: f.has('cacheCleanup'),
    cacheLimitMiB: Number(f.get('cacheLimitMiB')),
  });
  await refreshStorage();
  toast('보관 설정을 저장했습니다.');
});
$('storage-cleanup').onclick = guard(async () => {
  await api('/api/storage/cleanup', {});
  await refreshStorage();
  toast('현재 정책으로 일반 자료를 정리했습니다. 중요한 증거는 유지했습니다.');
});
function renderOperations() {
  if (!state.operations) return;
  $('storage-cleanup').disabled = !storageReport || state.busy;
  if (!storageLoaded && !storageLoading) {
    storageLoading = true;
    void refreshStorage()
      .catch(() => {
        storageLoaded = false;
      })
      .finally(() => {
        storageLoading = false;
      });
  }
  const u = state.usage;
  $('usage-summary').textContent =
    `오늘 AI 호출 ${u.calls}회 · 보고 토큰 ${u.tokens.toLocaleString()} · 가격이 설정된 호출의 추정 비용 $${u.estimatedUsd.toFixed(4)} · 사용량 미확인 ${u.unknown}회 · 단가 미설정 ${u.unpriced}회`;
  if (!operationsLoaded) {
    const form = $('operations-form');
    for (const key of [
      'queueEnabled',
      'dailyCalls',
      'dailyTokens',
      'dailyEstimatedUsd',
      'maxPending',
      'discoverySwitches',
    ]) {
      const el = form.elements.namedItem(key);
      if (el.type === 'checkbox') el.checked = state.operations[key];
      else el.value = state.operations[key] ?? '';
    }
    const rate = state.operations.rates.find((r) => r.model === state.selection?.model);
    form.elements.inputRate.value = rate?.inputPerMillion ?? '';
    form.elements.outputRate.value = rate?.outputPerMillion ?? '';
    operationsLoaded = true;
  }
  $('schedules').innerHTML = (state.schedules || [])
    .map(
      (s) =>
        `<article class="event-card"><div class="card-top"><span class="pill">${s.enabled ? '활성' : '정지'}</span><button data-schedule-delete="${esc(s.id)}">예약 삭제</button></div><h3>${esc(s.name)}</h3><p>${esc(s.intervalMinutes)}분 간격 · ${esc(s.startHour)}–${esc(s.endHour)}시 · 하루 ${esc(s.maxRunsPerDay)}회</p><p>${esc(s.provider.kind)} / ${esc(s.provider.model)}</p><p>${esc(s.note || '다음 운영 시간에 실행합니다.')}</p></article>`,
    )
    .join('');
}
$('operations-form').onsubmit = guard(async () => {
  const f = new FormData($('operations-form')),
    c = choice();
  let rates = state.operations.rates;
  if (f.get('inputRate') !== '' && f.get('outputRate') !== '') {
    if (c.kind !== 'api' || !c.model)
      throw new Error('비용 단가는 연결 설정에서 선택한 API 모델에 적용합니다.');
    rates = [
      ...rates.filter((r) => r.model !== c.model),
      {
        model: c.model,
        inputPerMillion: Number(f.get('inputRate')),
        outputPerMillion: Number(f.get('outputRate')),
      },
    ];
  }
  await api('/api/operations', {
    queueEnabled: f.has('queueEnabled'),
    dailyCalls: Number(f.get('dailyCalls')),
    dailyTokens: Number(f.get('dailyTokens')),
    maxPending: Number(f.get('maxPending')),
    discoverySwitches: Number(f.get('discoverySwitches')),
    dailyEstimatedUsd:
      f.get('dailyEstimatedUsd') === '' ? null : Number(f.get('dailyEstimatedUsd')),
    rates,
  });
  toast('운영 설정을 저장했습니다.');
});
$('schedule-form').onsubmit = guard(async () => {
  const f = new FormData($('schedule-form'));
  await api('/api/schedules', {
    name: f.get('name'),
    sourceUrl: f.get('sourceUrl'),
    enabled: f.has('enabled'),
    intervalMinutes: Number(f.get('intervalMinutes')),
    startHour: Number(f.get('startHour')),
    endHour: Number(f.get('endHour')),
    maxRunsPerDay: Number(f.get('maxRunsPerDay')),
    provider: requireChoice(),
    browserEngine: state.browser.engine,
    goal: $('goal').value,
    prepareOne: $('prepare-one').checked,
  });
  toast('탐색 예약을 저장했습니다.');
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-schedule-delete]');
  if (b) void guard(() => api('/api/schedules/delete', { id: b.dataset.scheduleDelete }))(e);
});

function resultGuide(e, o, compact = false) {
  if (!e) return '';
  const channels = new Set(e.winnerNotice?.channels || []);
  if (/DM|디엠/i.test(o?.check?.quote || '') && /instagram\.com/i.test(o?.check?.url || ''))
    channels.add('instagram_dm');
  const instructions = {
    instagram_dm: '인스타그램 DM · 응모한 계정의 받은 메시지와 메시지 요청함을 확인하세요.',
    direct_message: '개별 메시지 · 원문에 안내된 서비스와 계정을 확인하세요.',
    email: '이메일 · 응모할 때 등록한 주소의 받은편지함과 스팸함을 확인하세요.',
    sms: '문자 · 응모할 때 등록한 전화번호의 문자 수신함을 확인하세요.',
    phone: '전화 · 응모할 때 등록한 번호로 오는 주최자 연락을 확인하세요.',
    post_comment: '게시물 댓글 · 아래 발표 게시물의 주최자 댓글을 확인하세요.',
    site_notice: '홈페이지 공지 · 아래 발표 또는 이벤트 안내를 확인하세요.',
    story: '주최자 스토리 · 이벤트 원문에서 주최자 계정으로 이동해 확인하세요.',
  };
  const links = new Map();
  const add = (url, label) => {
    if (url && !links.has(url) && safeLink(url, label)) links.set(url, label);
  };
  add(o?.check?.url, '발표를 확인한 게시물·페이지');
  add(e.winnerNotice?.sourceUrl, '연락 방법 안내 원문');
  if (o?.sourceUrl && !/instagram\.com\/direct\//i.test(o.sourceUrl))
    add(o.sourceUrl, '저장된 결과 안내');
  add(e.sourceUrl, '이벤트 안내');
  add(e.entryUrl, '응모 페이지');
  const dm = o?.dmChecks || [];
  for (const d of dm) add(d.url, `@${d.organizer} DM 열기`);
  if (/instagram\.com\/direct\//i.test(o?.sourceUrl || '')) add(o.sourceUrl, '받은 당첨 DM 열기');
  const lines = [...channels].map((c) => instructions[c]).filter(Boolean);
  return `<section class="result-guide" aria-label="결과 확인 경로"><strong>어디서 확인하나요?</strong><p>${lines.length ? lines.map(esc).join('<br>') : '연락 방법은 아직 확인되지 않았습니다. 아래 발표·이벤트 원문에서 안내를 확인하세요.'}${e.winnerNotice?.basis === 'inferred' ? '<br>기존 메모에 따른 예상 경로입니다.' : ''}</p><div class="card-actions">${[...links].map(([url, label]) => safeLink(url, label)).join('')}</div>${!compact && dm.length ? `<p class="hint">최근 DM 확인<br>${dm.map((d) => `@${esc(d.organizer)} · ${esc({ no_evidence: '현재 읽은 대화에서 당첨 근거 없음 · 낙첨 확정 아님', unavailable: '자동 확인 불가 · 직접 확인 필요', review: '행사 연결 검토 필요', won: '당첨 근거 확인' }[d.state])} · ${esc(new Date(d.at).toLocaleString())}`).join('<br>')}</p>` : ''}${!compact && o?.check?.quote ? `<details><summary>발표 확인 근거</summary><blockquote>${esc(o.check.quote)}</blockquote><p>${esc(o.check.reason || '')}</p></details>` : ''}</section>`;
}
function knownRewardValue(r) {
  return r?.valueKnown ?? (r?.faceValue || 0) > 0;
}
function rewardProgressButtons(eventId) {
  const o = state.outcomes?.find((x) => x.eventId === eventId);
  if (o?.status !== 'won') return '';
  if (['received', 'used'].includes(o.reward?.status))
    return `<button data-reward-progress="${esc(eventId)}" data-stage="received">수령 기록 수정</button>`;
  if (o.reward?.status === 'expired') return '';
  return `${!o.followUp || o.followUp.state === 'needs_reply' ? `<button data-reward-progress="${esc(eventId)}" data-stage="replied">회신 완료로 기록</button>` : ''}<button data-reward-progress="${esc(eventId)}" data-stage="received">경품 받음 · 종결</button>`;
}
let receivedRewardLimit = 20;
function renderReceivedRewards(won) {
  const rows = won
    .filter((o) => ['received', 'used'].includes(o.reward?.status))
    .sort(
      (a, b) =>
        Date.parse(b.reward.receivedAt || b.updatedAt) -
        Date.parse(a.reward.receivedAt || a.updatedAt),
    );
  $('reward-received').innerHTML =
    rows
      .slice(0, receivedRewardLimit)
      .map((o) => {
        const e = state.completedEntries.find((e) => e.eventId === o.eventId),
          r = o.reward;
        return `<article class="event-card"><span class="pill">${r.status === 'used' ? '사용·처분 완료' : '수령 완료 · 종결'}</span><h4>${esc(r.name || e?.prize || '경품')}</h4><p>${esc(e?.title || '응모')}</p><p>${knownRewardValue(r) ? `${Number(r.faceValue).toLocaleString()}원` : '가치 미정'}${r.receivedAt ? ` · 수령 기록 ${esc(new Date(r.receivedAt).toLocaleDateString())}` : ''}</p><div class="card-actions">${rewardProgressButtons(o.eventId)}<button data-outcome="${esc(o.eventId)}">상세 기록</button></div></article>`;
      })
      .join('') ||
    '<p class="hint">아직 수령 완료로 기록한 경품이 없습니다. 경품을 받으면 ‘경품 받음 · 종결’로 정리하세요.</p>';
  if (rows.length > receivedRewardLimit)
    $('reward-received').innerHTML += '<button id="reward-received-more">20개 더 보기</button>';
}
function outcomeLabel(eventId) {
  const outcome = state.outcomes?.find((o) => o.eventId === eventId);
  if (outcome?.status === 'won' && outcome.reportedBy === 'agent')
    return '당첨 · 주최자 DM 근거 확인';
  return (
    {
      pending: '발표 대기',
      unconfirmed: '확인 불가',
      won: '당첨 · 사용자 확인',
      lost: '낙첨 · 사용자 확인',
    }[state.outcomes?.find((o) => o.eventId === eventId)?.status] || '아직 확인하지 않음'
  );
}
function renderOutcomeSummary() {
  renderResultBatch();
  renderDmChecks();
  const rows = state.outcomes || [],
    won = rows.filter((o) => o.status === 'won');
  const realized = won.reduce(
    (sum, o) => sum + (o.reward?.status === 'used' ? o.reward.realizedValue : 0),
    0,
  );
  renderReceivedRewards(won);
  $('outcome-summary').textContent =
    `접수 ${state.completedEntries.length}건 · 확인한 당첨 ${won.length}건 · 수령 ${won.filter((o) => ['received', 'used'].includes(o.reward?.status)).length}건 · 실현 가치 ${realized.toLocaleString()}원`;
  $('outcome-alerts').innerHTML = (state.outcomeAlerts || [])
    .map(
      (a) =>
        `<article class="event-card"><h4>${esc(a.title)}</h4><p>${esc(a.message)}</p><div class="card-actions"><button data-outcome="${esc(a.eventId)}">확인 경로·결과 열기</button>${rewardProgressButtons(a.eventId)}</div>${
          state.outcomes.find((o) => o.eventId === a.eventId)?.status !== 'won'
            ? resultGuide(
                state.completedEntries.find((e) => e.eventId === a.eventId),
                state.outcomes.find((o) => o.eventId === a.eventId),
                true,
              )
            : ''
        }</article>`,
    )
    .join('');
  const followStates = {
    needs_reply: '회신 필요',
    replied: '회신 완료 · 수령 대기',
    awaiting_delivery: '배송·발송 대기',
    done: '후속 처리 완료',
  };
  const followups = won.filter(
    (o) =>
      o.followUp?.state !== 'done' && !['received', 'used', 'expired'].includes(o.reward?.status),
  );
  $('reward-followups').innerHTML =
    followups
      .slice(0, rewardFollowupLimit)
      .map((o) => {
        const f = o.followUp || { state: 'awaiting_delivery' },
          e = state.completedEntries.find((e) => e.eventId === o.eventId);
        return `<article class="event-card"><span class="pill warning">${esc(followStates[f.state])}</span><h3>${esc(e?.title || '당첨')}</h3><p>${esc(o.reward?.name || e?.prize || '경품 확인 필요')}</p><p>연락 대상 · ${esc(f.recipient || '확인 필요')}</p>${f.state === 'needs_reply' && f.deadlineText ? `<p>회신 기한 · ${esc(f.deadlineText)}</p>` : ''}${f.state === 'needs_reply' && f.deadlineUncertain ? '<p class="consent-notice">기한 안내가 불명확하거나 서로 다릅니다. 원문을 확인하세요.</p>' : ''}${f.deliveryNote ? `<p>${esc(f.deliveryNote)}</p>` : ''}<div class="card-actions">${f.state === 'needs_reply' && (o.dmChecks || []).some((d) => d.state === 'won' && '@' + d.organizer === f.recipient) ? `<button data-dm-reply="${esc(o.eventId)}">수신 안내·회신 검토</button>` : ''}${rewardProgressButtons(o.eventId)}<button data-outcome="${esc(o.eventId)}">상세 기록·회신 초안</button><button data-followup-open="${esc(o.eventId)}">전용 브라우저에서 안내 열기</button></div></article>`;
      })
      .join('') +
    (followups.length > rewardFollowupLimit
      ? '<button id="more-reward-followups" type="button">당첨 후속 항목 20개 더 보기</button>'
      : '');
  notifyRewardAlerts();
}
let dmPlanLimit = 20;
function renderDmChecks() {
  const plan = state.dmCheckPlan || [],
    active = ['running', 'paused'].includes(state.resultBatch?.state);
  const announced = plan
    .filter(
      (x) =>
        x.eligible &&
        x.announced &&
        !['won', 'lost'].includes(state.outcomes.find((o) => o.eventId === x.eventId)?.status),
    )
    .slice(0, 20);
  const monitor = state.dmMonitor || {};
  $('dm-monitor-toggle').textContent = monitor.enabled ? '정기 점검 끄기' : '정기 점검 켜기';
  $('dm-monitor-status').textContent =
    (monitor.enabled
      ? (monitor.note || '점검 대기') +
        (monitor.nextAt ? ' · 다음 점검 ' + new Date(monitor.nextAt).toLocaleString() : '')
      : '정기 점검 꺼짐') +
    ' · 앱 실행 중 6시간마다 발표일이 지난 14일 이내의 완료 응모를 확인합니다. 발표일을 모르면 최근 완료한 DM 안내·발표 확인 건을 확인합니다.';
  $('dm-announced-start').disabled = active || !announced.length;
  $('dm-check-summary').textContent =
    `연결 가능한 완료 응모 ${plan.filter((x) => x.eligible).length}건 · 발표된 미확정 응모 ${announced.length}건. 묶음 실행 상태와 시간·토큰은 위 실행 결과에 표시합니다.`;
  const labels = {
    won: '당첨 근거 확인',
    review: '행사 연결 확인 필요',
    no_evidence: '당첨 근거 없음 · 낙첨 아님',
    unavailable: '자동 확인 불가',
  };
  $('dm-check-plan').innerHTML = plan
    .slice(0, dmPlanLimit)
    .map(
      (x) =>
        `<article class="event-card"><strong>${esc(x.title)}</strong><p>${esc(x.reason)}</p>${x.scope ? `<p>응모 계정 @${esc(x.scope.actor)} · 주최자 ${x.scope.organizers.map((h) => '@' + esc(h)).join(', ')} · ${esc(x.scope.profile)}</p>` : ''}${x.checks.map((d) => `<p><b>${esc(labels[d.state])}</b> · @${esc(d.organizer)} · ${new Date(d.at).toLocaleString()}<br>${esc(d.reason)}${d.lastAttempt ? `<br>최근 재확인 · ${esc(d.lastAttempt.reason)}` : ''}</p>`).join('')}${x.eligible ? `<button data-dm-check="${esc(x.eventId)}" ${active ? 'disabled' : ''}>이 응모 주최자 DM 확인</button>` : ''}</article>`,
    )
    .join('');
  $('dm-plan-more').hidden = plan.length <= dmPlanLimit;
  $('dm-reviews').innerHTML = plan
    .flatMap((x) =>
      x.checks
        .filter(
          (d) =>
            d.state === 'review' &&
            !d.reviewed &&
            !['won', 'lost'].includes(state.outcomes.find((o) => o.eventId === x.eventId)?.status),
        )
        .map(
          (d) =>
            `<article class="event-card"><span class="pill warning">당첨 DM · 행사 연결 확인</span><h4>${esc(x.title)}</h4><p>@${esc(d.organizer)} · ${esc(d.reason)}</p><blockquote>${esc(d.quote || '')}</blockquote>${d.deadlineText ? `<p>기한 원문 · ${esc(d.deadlineText)}</p>` : ''}<div class="card-actions"><button data-dm-review="${esc(x.eventId)}" data-key="${esc(d.key)}" data-confirm="true">이 응모의 당첨 안내가 맞음</button><button data-dm-review="${esc(x.eventId)}" data-key="${esc(d.key)}" data-confirm="false">이 응모와 연결하지 않음</button><button data-outcome="${esc(x.eventId)}">결과·경품 관리</button></div></article>`,
        ),
    )
    .join('');
}
$('dm-monitor-toggle').onclick = guard(() =>
  api('/api/outcomes/dm-monitor', {
    enabled: !state.dmMonitor?.enabled,
    provider: state.dmMonitor?.enabled ? state.dmMonitor.provider : requireChoice(),
  }),
);
let dmCard = null;
let dmCardRevision = 0;
async function loadDmCard() {
  const rev = ++dmCardRevision;
  const id = dmCard.eventId;
  const consent = $('dm-reply-consent').value;
  $('dm-reply-send').disabled = true;
  $('dm-reply-body').value = '';
  $('dm-reply-message').textContent = '회신안 확인 중…';
  const p = await api('/api/outcomes/dm-preview', { eventId: id, consent });
  if (!dmCard || rev !== dmCardRevision) return;
  dmCard = { eventId: id, consent, approval: p.approval, text: p.text };
  $('dm-reply-target').textContent = '@' + p.actor + ' → ' + p.recipient;
  $('dm-reply-source').textContent = p.source;
  $('dm-reply-body').value = p.text;
  $('dm-reply-message').textContent = p.reason || '받는 계정과 보낼 내용을 확인한 뒤 승인하세요.';
  $('dm-reply-send').disabled = !p.approval;
}
async function openDmCard(eventId) {
  const o = state.outcomes.find((o) => o.eventId === eventId);
  dmCard = { eventId };
  $('dm-reply-title').textContent =
    state.completedEntries.find((e) => e.eventId === eventId)?.title || '당첨 DM 회신';
  $('dm-reply-source').textContent = '';
  $('dm-reply-target').textContent = '';
  $('dm-reply-consent').value = 'unset';
  $('dm-consent-label').hidden = !o.followUp.requested.includes('consent');
  if (!$('dm-reply-dialog').open) $('dm-reply-dialog').showModal();
  await loadDmCard();
}
document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-dm-reply]');
  if (button) void guard(() => openDmCard(button.dataset.dmReply))(e);
});
$('dm-reply-consent').onchange = guard(loadDmCard);
$('dm-reply-dialog').onclose = () => {
  dmCard = null;
  dmCardRevision++;
  $('dm-reply-body').value = '';
  $('dm-reply-source').textContent = '';
};
$('dm-reply-send').onclick = guard(async () => {
  if (!dmCard?.approval) return;
  const request = dmCard;
  $('dm-reply-send').disabled = true;
  $('dm-reply-message').textContent = '수신 대화 재확인 및 회신 처리 중…';
  try {
    await api('/api/outcomes/dm-send', request);
    $('dm-reply-dialog').close();
    toast('주최자 대화에서 발신 메시지를 확인했습니다.');
  } catch (err) {
    $('dm-reply-message').textContent = err.message;
    throw err;
  }
});
$('dm-plan-more').onclick = () => {
  dmPlanLimit += 20;
  renderDmChecks();
};
$('dm-announced-start').onclick = guard(async () => {
  const eventIds = (state.dmCheckPlan || [])
    .filter(
      (x) =>
        x.eligible &&
        x.announced &&
        !['won', 'lost'].includes(state.outcomes.find((o) => o.eventId === x.eventId)?.status),
    )
    .slice(0, 20)
    .map((x) => x.eventId);
  await api('/api/outcomes/dm-batch', { provider: requireChoice(), eventIds });
});
document.addEventListener('click', (e) => {
  const check = e.target.closest('[data-dm-check]'),
    review = e.target.closest('[data-dm-review]');
  if (check)
    void guard(() =>
      api('/api/outcomes/dm-batch', {
        provider: requireChoice(),
        eventIds: [check.dataset.dmCheck],
      }),
    )(e);
  if (review)
    void guard(async () => {
      const eventId = review.dataset.dmReview;
      const confirm = review.dataset.confirm === 'true';
      await api('/api/outcomes/dm-review', { eventId, key: review.dataset.key, confirm });
      if (confirm) {
        await refresh();
        if (state.outcomes.find((o) => o.eventId === eventId)?.followUp?.state === 'needs_reply')
          await openDmCard(eventId);
      }
    })(e);
});
let resultPlanLimit = 20;
let resultRowsLimit = 20;
function renderResultBatch() {
  const plan = state.resultCheckPlan || [],
    b = state.resultBatch;
  const eligible = plan.filter((x) => x.eligible).length;
  const active = b && ['running', 'paused'].includes(b.state);
  $('result-batch-start').disabled = active || !eligible;
  $('result-batch-pause').hidden = b?.state !== 'running';
  $('result-batch-resume').hidden = b?.state !== 'paused';
  $('result-batch-stop').hidden = !active;
  const labels = {
    announced: '발표 발견 · 본인 결과 확인 필요',
    pending: '발표 대기',
    unavailable: '자동 확인 불가',
  };
  const readReasons = {
    result_source_outside_scope:
      '이번 공개 페이지 읽기 범위 밖의 주소로 이동하려 해 중단했습니다. 별도 발표 페이지가 있으면 결과·발표 주소 설정에서 지정해 주세요.',
    result_requires_user_check:
      '자동 읽기로 처리할 수 없는 동작이 필요해 멈췄습니다. 원문을 직접 확인해 주세요. 게시·신청은 실행하지 않았습니다.',
    result_check_limit:
      '이번 확인 한도 안에서 발표 근거를 확보하지 못했습니다. 낙첨으로 처리하지 않습니다.',
  };
  $('result-batch-status').textContent = b
    ? `${{ running: '일괄 확인 중', paused: '일시정지', completed: '일괄 확인 종료', stopped: '사용자가 종료' }[b.state]} · ${b.items.filter((x) => ['done', 'skipped'].includes(x.state)).length}/${b.items.length}건 처리 · ${b.note} · AI 호출 ${b.metrics.calls}회${b.metrics.unreported ? ` (사용량 미보고 ${b.metrics.unreported}회)` : ''} / 입력 ${b.metrics.inputTokens.toLocaleString()}·출력 ${b.metrics.outputTokens.toLocaleString()} 토큰 / 실행 ${(b.metrics.activeMs / 1000).toFixed(1)}초${b.mode === 'instagram_dm' ? ` / 대화 읽기 자동 복구 ${b.metrics.automaticRecoveries || 0}회` : ''}`
    : `지금 확인 가능 ${eligible}건 · 제외/대기 ${plan.length - eligible}건. 발표 주소를 하나씩 등록할 필요 없이 시작할 수 있습니다.`;
  $('result-batch-results').innerHTML = (b?.items || [])
    .slice(0, resultRowsLimit)
    .map(
      (x) =>
        `<article class="event-card"><span class="pill">${esc(x.state === 'pending' ? '대기' : x.state === 'running' ? '확인 중' : x.state === 'skipped' ? '제외' : (b.mode === 'instagram_dm' ? 'DM 확인 결과' : labels[x.check?.state]) || '확인 중단')}</span><h4>${esc(x.title)}</h4><p>${esc(b.mode === 'instagram_dm' ? (x.dmChecks || []).map((d) => '@' + d.organizer + ' · ' + d.reason).join(' / ') || x.note : x.check?.reason || readReasons[x.note] || x.note || '')}</p>${x.check?.quote ? `<blockquote>${esc(x.check.quote)}</blockquote>` : ''}<div class="card-actions">${safeLink(x.check?.url || x.sourceUrl, '확인 경로 열기')}${x.state === 'done' ? `<button data-outcome="${esc(x.eventId)}">결과·경품 관리</button>` : ''}</div></article>`,
    )
    .join('');
  $('result-batch-more').hidden = (b?.items.length || 0) <= resultRowsLimit;
  $('result-plan-summary').textContent =
    `확인 대상과 제외 이유 · 가능 ${eligible} / 전체 ${plan.length}`;
  $('result-plan').innerHTML = plan
    .slice(0, resultPlanLimit)
    .map(
      (x) =>
        `<article class="event-card"><strong>${esc(x.title)}</strong><p>${x.eligible ? '확인 가능' : '대기·제외'} · ${esc(x.reason)}</p><button data-outcome="${esc(x.eventId)}">결과·발표 주소 설정</button></article>`,
    )
    .join('');
  $('result-plan-more').hidden = plan.length <= resultPlanLimit;
}
$('result-plan-more').onclick = () => {
  resultPlanLimit += 20;
  renderResultBatch();
};
$('result-batch-more').onclick = () => {
  resultRowsLimit += 20;
  renderResultBatch();
};
$('result-batch-start').onclick = guard(async () => {
  await api('/api/outcomes/batch', {
    provider: requireChoice(),
    limit: Number($('result-batch-limit').value),
  });
});
for (const action of ['pause', 'resume', 'stop'])
  $('result-batch-' + action).onclick = guard(async () => {
    await api('/api/outcomes/batch/control', { action });
  });
document.addEventListener('click', (event) => {
  const b = event.target.closest('[data-outcome]');
  if (!b) return;
  const e = state.completedEntries.find((e) => e.eventId === b.dataset.outcome);
  if (!e) return;
  const o = state.outcomes.find((o) => o.eventId === e.eventId),
    form = $('outcome-form');
  form.reset();
  form.hidden = false;
  $('reward-code').textContent = '';
  $('claim-reply-draft').value = '';
  $('claim-reply-status').textContent = '';
  $('claim-consent').value = 'unset';
  $('outcome-title').textContent = e.title;
  const values = {
    eventId: e.eventId,
    sourceUrl: o?.sourceUrl || e.sourceUrl,
    status: o?.status || 'pending',
    note: o?.note || '',
    claimBy: o?.claimBy || '',
    checkDate: o?.nextCheckAt
      ? new Date(o.nextCheckAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
      : e.announcementDate || '',
    rewardName: o?.reward?.name || '',
    rewardStatus: o?.reward?.status || 'expected',
    expiresOn: o?.reward?.expiresOn || '',
    faceValue: o?.reward?.faceValue || 0,
    realizedValue: o?.reward?.realizedValue || 0,
    followUpState: o?.followUp?.state || 'needs_reply',
    followUpChannel: o?.followUp?.channel || 'instagram_dm',
    followUpRecipient: o?.followUp?.recipient || '',
    deadlineText: o?.followUp?.deadlineText || '',
    deliveryNote: o?.followUp?.deliveryNote || '',
  };
  for (const [k, v] of Object.entries(values)) form.elements.namedItem(k).value = v;
  form.elements.autoCheck.checked = !!o?.autoCheck;
  form.elements.hasFollowUp.checked = !!o?.followUp;
  form.elements.valueKnown.checked = knownRewardValue(o?.reward);
  form.elements.deadlineUncertain.checked = !!o?.followUp?.deadlineUncertain;
  for (const input of form.querySelectorAll('input[name=requested]'))
    input.checked = !!o?.followUp?.requested.includes(input.value);
  $('check-outcome').disabled = /instagram\.com\/direct\//i.test(values.sourceUrl);
  $('outcome-proof').innerHTML = o?.check
    ? `<blockquote>${esc(o.check.quote)}</blockquote><p>${safeLink(o.check.url, '확인한 발표')} · ${esc(new Date(o.check.at).toLocaleString())}</p><a href="/evidence/${esc(o.check.screenshot)}" target="_blank">확인 당시 화면 ↗</a>`
    : '';
  $('outcome-guide').innerHTML = resultGuide(e, o);
  $('outcome-dialog').showModal();
  $('outcome-dialog').scrollTop = 0;
});
$('outcome-form').onsubmit = guard(async () => {
  const f = new FormData($('outcome-form'));
  await api('/api/outcomes', {
    eventId: f.get('eventId'),
    sourceUrl: f.get('sourceUrl'),
    status: f.get('status'),
    note: f.get('note'),
    autoCheck: f.has('autoCheck'),
    nextCheckAt: f.get('checkDate') ? Date.parse(`${f.get('checkDate')}T09:00:00+09:00`) : null,
    claimBy: f.get('claimBy') || null,
    followUp:
      f.get('status') === 'won' && f.has('hasFollowUp')
        ? {
            state: f.get('followUpState'),
            channel: f.get('followUpChannel'),
            recipient: f.get('followUpRecipient'),
            requested: f.getAll('requested'),
            deadlineText: f.get('deadlineText'),
            deadlineUncertain: f.has('deadlineUncertain'),
            deliveryNote: f.get('deliveryNote'),
          }
        : null,
    reward:
      f.get('status') === 'won'
        ? {
            name: f.get('rewardName'),
            status: f.get('rewardStatus'),
            expiresOn: f.get('expiresOn') || null,
            faceValue: f.has('valueKnown') ? Number(f.get('faceValue')) : 0,
            valueKnown: f.has('valueKnown'),
            realizedValue: Number(f.get('realizedValue')),
            code: f.get('code'),
          }
        : undefined,
  });
  $('outcome-form').elements.code.value = '';
  $('reward-code').textContent = '';
  $('outcome-dialog').close();
  toast('결과·경품을 저장했습니다.');
});
$('check-outcome').onclick = guard(async () => {
  await api('/api/outcomes/check', {
    eventId: $('outcome-form').elements.eventId.value,
    provider: requireChoice(),
  });
  toast('저장된 공식 발표 주소를 읽는 작업을 시작했습니다.');
});
$('prepare-claim-reply').onclick = guard(async () => {
  const result = await api('/api/outcomes/reply-draft', {
    eventId: $('outcome-form').elements.eventId.value,
    consent: $('claim-consent').value,
  });
  $('claim-reply-draft').value = result.text;
  $('claim-reply-status').textContent =
    `받는 곳: ${result.recipient || '확인 필요'} · ${result.missing.length ? '직접 확인: ' + result.missing.join(', ') : '필요 정보 준비됨'} · 초안이며 아직 전송하지 않았습니다.`;
});
$('copy-claim-reply').onclick = guard(async () => {
  const text = $('claim-reply-draft').value;
  if (!text.trim()) throw new Error('먼저 회신 초안을 준비하세요.');
  if (/\[(?:확인 후 입력|동의 안내를 읽고 선택해 주세요)\]/.test(text))
    throw new Error('초안의 미확인 항목을 먼저 확인해 주세요.');
  await navigator.clipboard.writeText(text);
  toast('검토한 초안을 복사했습니다. 안내의 받는 계정을 확인하고 직접 보내세요.');
});
$('clear-claim-reply').onclick = () => {
  $('claim-reply-draft').value = '';
  $('claim-reply-status').textContent = '';
};
document.addEventListener('click', (e) => {
  if (e.target.closest('#more-reward-followups')) {
    rewardFollowupLimit += 20;
    renderOutcomeSummary();
    return;
  }
  const button = e.target.closest('[data-followup-open]');
  if (button)
    void guard(async () => {
      const o = state.outcomes.find((o) => o.eventId === button.dataset.followupOpen);
      await api('/api/browser/open', { url: o.sourceUrl });
      toast('당첨 안내를 전용 브라우저에서 열었습니다.');
    })(e);
});

const rewardAlertPreference = 'ssal:reward-notifications';
let rewardChoices = [];
function explicitVoucherValue(name) {
  if (/총|최대|상당/.test(name)) return undefined;
  const amounts = [...name.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(만|천)?\s*원권/g)];
  if (amounts.length !== 1) return undefined;
  const match = amounts[0],
    value = Number(match[1].replaceAll(',', '')) * ({ 만: 10000, 천: 1000 }[match[2]] || 1);
  return Number.isFinite(value) && value <= 100000000 ? value : undefined;
}
function updateRewardProgressFields() {
  const form = $('reward-progress-form'),
    received = form.elements.stage.value === 'received';
  $('reward-receipt-fields').hidden = !received;
  $('reward-receipt-fields').disabled = !received;
  const known = form.elements.valueKind.value === 'known';
  $('reward-value-field').hidden = !known;
  form.elements.faceValue.disabled = !received || !known;
  form.elements.faceValue.required = received && known;
  $('reward-progress-save').textContent = received ? '수령 완료로 저장' : '진행 상태 저장';
}
function chooseRewardPrize() {
  const form = $('reward-progress-form'),
    item = rewardChoices[Number($('reward-prize-choice').value)];
  if ($('reward-prize-choice').value === 'custom') {
    form.elements.rewardName.value = '';
    form.elements.valueKind.value = 'unknown';
    form.elements.faceValue.value = '';
    form.elements.rewardName.focus();
  } else if (item) {
    form.elements.rewardName.value = item.name;
    form.elements.valueKind.value = item.value === undefined ? 'unknown' : 'known';
    form.elements.faceValue.value = item.value ?? '';
  }
  updateRewardProgressFields();
}
document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-dialog]');
  if (close) $(close.dataset.closeDialog).close();
  if (event.target.closest('#reward-received-more')) {
    receivedRewardLimit += 20;
    renderOutcomeSummary();
  }
  const button = event.target.closest('[data-reward-progress]');
  if (!button) return;
  const o = state.outcomes.find((o) => o.eventId === button.dataset.rewardProgress),
    e = state.completedEntries.find((e) => e.eventId === o?.eventId);
  if (!o || o.status !== 'won' || !e) return;
  const form = $('reward-progress-form');
  form.reset();
  form.elements.eventId.value = o.eventId;
  form.elements.expectedUpdatedAt.value = o.updatedAt;
  form.elements.stage.value = button.dataset.stage || 'replied';
  $('reward-progress-event').textContent = e.title;
  rewardChoices = [
    ...new Set([o.reward?.name, e.prize].filter(Boolean).map((n) => n.slice(0, 200))),
  ].map((name) => ({
    name,
    value:
      name === o.reward?.name && o.reward.valueKnown === false
        ? undefined
        : name === o.reward?.name && knownRewardValue(o.reward)
          ? o.reward.faceValue
          : explicitVoucherValue(name),
  }));
  $('reward-prize-choice').innerHTML =
    rewardChoices.map((r, i) => `<option value="${i}">${esc(r.name)}</option>`).join('') +
    '<option value="custom">기타 · 직접 입력</option>';
  $('reward-prize-choice').value = rewardChoices.length ? '0' : 'custom';
  chooseRewardPrize();
  $('reward-progress-error').hidden = true;
  $('reward-progress-dialog').showModal();
});
$('reward-progress-form').onchange = updateRewardProgressFields;
$('reward-prize-choice').onchange = chooseRewardPrize;
$('reward-progress-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = $('reward-progress-save');
  if (button.disabled) return;
  button.disabled = true;
  $('reward-progress-error').hidden = true;
  const f = new FormData(form),
    received = f.get('stage') === 'received';
  try {
    await api('/api/outcomes/progress', {
      eventId: f.get('eventId'),
      expectedUpdatedAt: f.get('expectedUpdatedAt'),
      stage: f.get('stage'),
      ...(received
        ? {
            rewardName: f.get('rewardName'),
            valueKnown: f.get('valueKind') === 'known',
            faceValue: f.get('valueKind') === 'known' ? Number(f.get('faceValue')) : null,
          }
        : {}),
    });
    await refresh();
    $('reward-progress-dialog').close();
    toast(
      received
        ? '수령 완료로 정리했습니다. 수령한 경품 목록에서 다시 수정할 수 있습니다.'
        : '회신·배송 상태를 기록했습니다.',
    );
  } catch (error) {
    $('reward-progress-error').textContent =
      {
        reward_progress_changed:
          '다른 작업에서 기록이 변경됐습니다. 창을 닫았다가 다시 열어 최신 내용을 확인하세요.',
        confirmed_win_required: '당첨이 확인된 응모에서만 진행 상태를 기록할 수 있습니다.',
        reward_progress_use_details: '이미 사용·만료된 경품은 상세 기록에서 수정하세요.',
        reward_receipt_fields_required: '받은 경품명과 금액 확인 여부를 선택해 주세요.',
        pause_before_updating_outcome:
          '이 응모의 확인 작업이 진행 중입니다. 작업이 끝난 뒤 저장하세요.',
      }[error.message] || error.message;
    $('reward-progress-error').hidden = false;
  } finally {
    button.disabled = false;
  }
};
$('outcome-dialog').addEventListener('close', () => {
  $('outcome-form').elements.code.value = '';
  $('reward-code').textContent = '';
  $('claim-reply-draft').value = '';
  $('claim-reply-status').textContent = '';
});
const rewardAlertLedger = 'ssal:reward-notifications-seen';
function notifyRewardAlerts() {
  const enabled = localStorage.getItem(rewardAlertPreference) === 'on';
  const supported = 'Notification' in window;
  $('reward-notification-status').textContent = !supported
    ? '이 브라우저는 알림을 지원하지 않습니다.'
    : enabled && Notification.permission === 'granted'
      ? '브라우저 알림 켜짐 · 앱과 대시보드 탭이 실행 중일 때만 동작합니다. 알림에는 개인정보를 표시하지 않습니다.'
      : '브라우저 알림 꺼짐 · 버튼을 눌러 이 브라우저에서 허용할 수 있습니다. 대시보드 알림은 계속 표시됩니다.';
  if (!enabled || !supported || Notification.permission !== 'granted') return;
  let seen;
  try {
    seen = JSON.parse(localStorage.getItem(rewardAlertLedger) || '{}');
  } catch {
    seen = {};
  }
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) seen = {};
  const fresh = (state.outcomeAlerts || []).filter(
    (a) => !seen[a.key || a.eventId + ':' + a.message],
  );
  if (!fresh.length) return;
  try {
    const notification = new Notification('쌀-GPT · 당첨·수령 확인', {
      body: `확인할 새 항목 ${fresh.length}개가 있습니다. 대시보드에서 안내와 기한을 확인하세요.`,
      tag: 'ssal-reward-attention',
    });
    notification.onclick = () => {
      window.focus();
      location.hash = 'rewards';
      notification.close();
    };
    for (const a of fresh) seen[a.key || a.eventId + ':' + a.message] = Date.now();
    localStorage.setItem(
      rewardAlertLedger,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(seen)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 200),
        ),
      ),
    );
  } catch {
    $('reward-notification-status').textContent =
      '브라우저 알림을 표시하지 못했습니다. 대시보드에서 확인하세요.';
  }
}
$('enable-reward-notifications').onclick = guard(async () => {
  if (!('Notification' in window)) throw new Error('이 브라우저는 알림을 지원하지 않습니다.');
  const permission = await Notification.requestPermission();
  if (permission === 'granted') localStorage.setItem(rewardAlertPreference, 'on');
  else localStorage.removeItem(rewardAlertPreference);
  notifyRewardAlerts();
});
$('disable-reward-notifications').onclick = () => {
  localStorage.removeItem(rewardAlertPreference);
  notifyRewardAlerts();
};
$('show-reward-code').onclick = guard(async () => {
  const result = await api('/api/outcomes/code', {
    eventId: $('outcome-form').elements.eventId.value,
  });
  $('reward-code').textContent = result.code || '저장된 코드 없음';
});

$('connect-browser-form').onsubmit = guard(async () => {
  const f = new FormData($('connect-browser-form'));
  const result = await api('/api/browser/connect-list', { endpoint: f.get('endpoint') });
  $('connect-tabs').innerHTML =
    result.tabs
      .map(
        (t) =>
          `<article class="event-card"><h3>${esc(t.title || '제목 없음')}</h3><p>${esc(t.url)}</p><button data-connect-tab="${esc(t.id)}">이 탭만 연결</button></article>`,
      )
      .join('') || '<p>연결할 탭이 없습니다.</p>';
});
document.addEventListener('click', (event) => {
  const b = event.target.closest('[data-connect-tab]');
  if (b)
    void guard(async () => {
      await api('/api/browser/connect-tab', { tabId: b.dataset.connectTab });
      $('connect-tabs').innerHTML = '';
      toast('선택한 탭만 연결했습니다.');
    })(event);
});

$('autonomy-demo-extended').onclick = guard(async () => {
  await api('/api/jobs', {
    kind: 'autonomy_demo',
    provider: requireChoice(),
    goal: '가상 프로필로 ARIA 선택 문항과 3단계 동의 위임을 검증하는 합성 설문을 완료해 주세요.',
    demoExtended: true,
    maxSteps: 30,
  });
  toast('실제 경품이 없는 확장 합성 테스트를 시작했습니다. 모델 사용량은 발생합니다.');
});
$('journey-demo').onclick = guard(async () => {
  await api('/api/jobs', {
    kind: 'autonomy_demo',
    provider: requireChoice(),
    goal: '합성 SNS 과제와 순위·파일 폼을 차례로 완료하세요.',
    demoJourney: true,
    maxSteps: 40,
  });
  toast(
    '실제 경품이 없는 혼합 과제 테스트입니다. 과제 승인·파일 선택·최종 확인은 대시보드에서 진행합니다.',
  );
});

let selectionLoaded = false;
function fillSelection(p) {
  const f = $('selection-policy-form').elements;
  for (const k of [
    'mode',
    'prizeMode',
    'personalResponses',
    'newConnections',
    'registrations',
    'discoveryCalls',
    'discoveryTokens',
    'entryTokens',
    'maxMinutes',
    'maxQuestions',
    'maxCalls',
    'maxSwitches',
  ])
    if (k in p) f[k].value = p[k] ?? '';
  if (p.allowedTasks)
    for (const el of $('selection-policy-form').querySelectorAll('[name=allowedTasks]'))
      el.checked = p.allowedTasks.includes(el.value);
  if (p.excludedTypes)
    for (const o of f.excludedTypes.options) o.selected = p.excludedTypes.includes(o.value);
  if ('switchOnBurden' in p) f.switchOnBurden.checked = p.switchOnBurden;
}
$('selection-policy-form').elements.mode.onchange = () =>
  fillSelection(state.selectionPresets[$('selection-policy-form').elements.mode.value]);
function connectionActions(c) {
  if (c.state === 'not_required') return '';
  return `${c.state === 'blocked' ? '<p class="warning-text">전용 브라우저의 로그인이 거부됐습니다. 같은 로그인 절차를 반복하지 말고 필요한 참여 페이지를 일반 브라우저에서 직접 열 수 있습니다.</p>' : ''}
    <div class="inline">${c.state === 'blocked' ? '' : `<button data-login="${esc(c.url)}" ${state.busy ? 'disabled' : ''}>열기 · 직접 로그인</button>`}
    ${c.id === 'google' || c.state === 'blocked' ? `<button data-external="${esc(c.url)}">일반 브라우저에서 직접 열기</button>` : ''}
    <button data-check-site="${esc(c.id)}" ${state.busy || state.browser?.engine === 'connected' ? 'disabled' : ''}>상태 확인</button></div>
    ${c.id === 'google' || c.state === 'blocked' ? '<p class="hint">일반 브라우저는 직접 참여용입니다. 그곳의 로그인 상태는 전용 브라우저에 전달되지 않습니다.</p>' : ''}`;
}
function renderConnections() {
  const labels = {
    unknown: '미확인',
    signed_in_visible: '로그인 확인',
    login_required: '로그인 필요',
    blocked: '브라우저 로그인 거부',
    closed: '브라우저 닫힘',
    not_required: '로그인 불필요',
  };
  const rows = state.connections || [];
  $('site-connections').innerHTML = rows
    .map(
      (c) =>
        `<article class="connection-card"><div class="card-top"><strong>${esc(c.name)}</strong><span class="pill">${esc(c.stale ? '재확인 필요' : labels[c.state] || '미확인')}</span></div><p class="hint">${esc(c.note)}</p><p>마지막 확인: ${c.checkedAt ? esc(new Date(c.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })) : '아직 확인하지 않음'}</p>${c.message ? `<p class="hint">${esc(c.message)}</p>` : ''}${connectionActions(c)}</article>`,
    )
    .join('');
  const needed = rows.filter((c) => c.requiredBy.length);
  $('connection-attention').innerHTML = needed.length
    ? `<section class="panel connection-inbox"><h3>필요한 연결 · ${needed.length}개 사이트</h3><p>선택한 후보·진행 중 작업에 필요한 연결을 모았습니다. 전용 브라우저에서 연결을 마치면 상태를 재확인하세요. 로그인 거부 시 일반 브라우저는 직접 참여용이며 자동 응모로 이어지지 않습니다.</p>${needed
        .map(
          (c) =>
            `<article><strong>${esc(c.name)}</strong><ul>${c.requiredBy
              .slice(0, 10)
              .map(
                (n) =>
                  `<li>${esc(n.title)} · ${esc(n.reason)}${c.state === 'blocked' || c.id === 'google' ? `<br><button data-external="${esc(n.targetUrl || c.url)}">참여 페이지를 일반 브라우저에서 직접 열기</button>` : ''}</li>`,
              )
              .join(
                '',
              )}</ul>${c.state === 'blocked' ? '<p class="warning-text">전용 브라우저 로그인 거부 · 일반 브라우저의 로그인 상태는 자동 공유되지 않습니다.</p>' : `<button data-login="${esc(c.url)}" ${state.busy ? 'disabled' : ''}>${esc(c.name)} 열기 · 로그인</button>`}</article>`,
        )
        .join(
          '',
        )}<button id="needed-connections-check" ${state.busy || state.browser?.engine === 'connected' ? 'disabled' : ''}>필요한 연결 상태 함께 재확인</button></section>`
    : '';
  $('connections-check').disabled = state.busy || state.browser?.engine === 'connected';
}
function renderSelection() {
  renderConnections();
  if (state.instagramBrowser && renderedInstagramRevision !== state.instagramBrowser.revision) {
    $('instagram-browser-enabled').checked = state.instagramBrowser.enabled;
    renderedInstagramRevision = state.instagramBrowser.revision;
  }
  $('task-permission-list').innerHTML = (state.taskPermissions || [])
    .map(
      (p) =>
        `<p>${safeLink(p.taskUrl, '허용 대상')} · ${p.kinds.map(esc).join(', ')} · ${esc(new Date(p.expires).toLocaleString())}<br>${esc(p.evidence)} <button type="button" data-revoke-permission="${esc(p.taskUrl)}">허용 근거 철회</button></p>`,
    )
    .join('');
  if (!selectionLoaded && state.selectionPolicy) {
    const f = $('selection-policy-form'),
      p = state.selectionPolicy;
    fillSelection(p);
    f.elements.facts.value = p.facts.map((v) => `${v.key}=${v.value}`).join('\n');
    f.elements.preferredPrizes.value = p.preferredPrizes.join(', ');
    for (const option of f.elements.excludedTypes.options)
      option.selected = p.excludedTypes.includes(option.value);
    for (const k of ['maxMinutes', 'maxQuestions', 'maxCalls', 'maxSwitches'])
      f.elements[k].value = p[k];
    f.elements.switchOnBurden.checked = p.switchOnBurden;
    selectionLoaded = true;
    void loadReport().catch((e) => toast(e.message, true));
  }
  const select = $('quality-form').elements.eventId,
    previous = select.value;
  const html = state.events
    .map((e) => `<option value="${esc(e.id)}">${esc(e.title)}</option>`)
    .join('');
  if (select.innerHTML !== html) {
    select.innerHTML = html;
    if (previous) select.value = previous;
  }
}
function renderReadTraces(job) {
  if (!job.readTraces?.length) return '';
  const reasons = {
    missing_ref: '선택한 좌표에 관찰 요소가 연결되지 않음',
    unknown_ref: '관찰 목록에 없는 요소',
    not_read_control: '읽기 이동으로 분류되지 않은 요소',
    wrong_observation: '이전 화면의 선택',
    stale_observation: '선택 후 화면이 변경됨',
    read_action: '읽기 동작 실행',
    read_plan: '읽기 계획 확인',
    candidate_evidence_verified: '후보의 원문 근거 확인',
    draft_ready: '권장 댓글 준비 완료',
    draft_personal_input: '공개 부분 준비 완료 · 개인 답변 확인',
    draft_personal_plan_required: '공개 부분과 개인 질문 분리 재요청',
    draft_source_quote_unmatched: '원문 인용 불일치 · 근거 수정 요청',
    draft_image_source_mismatch: '이미지와 근거 출처 불일치',
    draft_image_clue_missing: '이미지 단서 설명 누락',
    draft_basis_missing: '초안 근거 유형 누락',
    candidate_requirements_unresolved: '필수 답안을 확인할 수 없어 후보 전환 판단',
    draft_requirements: '필수 댓글 조건 미충족',
    draft_evidence: '답안 근거 미확인',
  };
  return `<details><summary>화면 읽기 판단 기록 · ${job.readTraces.length}회</summary><ol>${job.readTraces.map((t) => `<li><strong>${esc(reasons[t.reason] || t.reason || t.status)}</strong> · ${esc(t.action || '관찰')} ${t.ref ? `요소 ${esc(t.ref)}` : t.coordinate ? '좌표 선택' : ''} · <a href="/evidence/${esc(t.screenshot)}" target="_blank" rel="noreferrer">당시 화면 ↗</a></li>`).join('')}</ol></details>`;
}
function renderDraftPreparation(task) {
  const draft = task.draftPreparation;
  if (!draft) return '';
  const basis = {
    source_text: '원문 텍스트 근거',
    source_image: '원문 이미지 근거',
    inference: '공개 단서에 따른 AI 추론',
    suggestion: 'AI 문구 제안',
  };
  return `<div class="hint draft-preparation"><strong>${draft.commentPlan ? 'AI 부분 초안 · 개인 답변만 확인' : draft.state === 'ready' ? 'AI 권장 댓글 · ' + (basis[draft.basis] || '초안') : '댓글 준비 확인 필요'}</strong><p>${esc(draft.reason || '')}</p>${draft.evidenceQuote ? `<blockquote>${esc(draft.evidenceQuote)}</blockquote>` : ''}${draft.sourceUrl ? safeLink(draft.sourceUrl, '답안 근거 열기') : ''}${draft.quiz?.length ? `<details><summary>AI 풀이 기록 · ${draft.quiz.length}문항</summary><ul>${draft.quiz.map((q) => `<li>${esc(q.question)} — 먼저 푼 답: ${esc(q.answer)} · ${q.key ? `공개 정답: ${esc(q.key.answer)} (${q.answer === q.key.answer ? '일치' : '불일치'})` : '정답 확인 전'}</li>`).join('')}</ul></details>` : ''}</div>`;
}
function composeCommentPreview(plan, answers) {
  return plan.parts
    .map((p) => {
      if ('text' in p) return p.text;
      const q = plan.inputs.find((i) => i.id === p.inputId);
      const answer = Object.hasOwn(answers, p.inputId) ? answers[p.inputId].trim() : '';
      const text = q.kind === 'choice' ? q.options.find((o) => o.id === answer)?.text : answer;
      return text ? p.prefix + text + p.suffix : '';
    })
    .join('')
    .trim();
}
function renderCommentEditor(task) {
  const plan = task.draftPreparation?.commentPlan;
  const answers = task.draftPreparation?.personalAnswers || {};
  return `${renderDraftPreparation(task)}<div data-comment-editor="${esc(task.id)}" data-generated="${esc(plan ? composeCommentPreview(plan, answers) : task.draft || '')}">${plan ? `<div class="comment-personal"><strong>본인만 답할 수 있는 부분 · ${plan.inputs.length}개</strong><p class="hint">공개 답안은 AI가 준비했습니다. 아래 답변을 고르면 댓글 본문에 합쳐집니다.</p>${plan.inputs.map((q) => `<label>${esc(q.label)}${q.kind === 'choice' ? `<select data-comment-input="${esc(q.id)}" name="personal-${esc(task.id)}-${esc(q.id)}" required><option value="">직접 선택</option>${q.options.map((o) => `<option value="${esc(o.id)}" ${answers[q.id] === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : `<input data-comment-input="${esc(q.id)}" name="personal-${esc(task.id)}-${esc(q.id)}" required maxlength="600" value="${esc(answers[q.id] || '')}">`}</label>`).join('')}</div>` : ''}<label>게시할 댓글 본문 · 수정 가능<textarea name="text-${esc(task.id)}" required maxlength="2000" rows="3">${esc(task.draft || '')}</textarea></label><p class="hint">이 입력칸의 내용만 공개됩니다. 위 설명이나 승인 안내는 복사하지 마세요.</p>${plan ? '<button type="button" data-compose-comment hidden>선택한 답변으로 댓글 다시 만들기</button>' : ''}</div>`;
}
function updateCommentPreview(editor, force = false) {
  const form = editor.closest('[data-task-review]');
  const task = state.jobs
    .find((j) => j.id === form.dataset.taskReview)
    ?.tasks.find((t) => t.id === editor.dataset.commentEditor);
  const plan = task?.draftPreparation?.commentPlan;
  if (!plan) return;
  const answers = Object.fromEntries(
    [...editor.querySelectorAll('[data-comment-input]')].map((el) => [
      el.dataset.commentInput,
      el.value,
    ]),
  );
  const copy = composeCommentPreview(plan, answers);
  const textarea = editor.querySelector('textarea');
  const button = editor.querySelector('[data-compose-comment]');
  if (force || textarea.value === editor.dataset.generated) {
    textarea.value = copy;
    editor.dataset.generated = copy;
    button.hidden = true;
  } else button.hidden = false;
}
document.addEventListener('input', (e) => {
  if (e.target.matches('[data-comment-input]'))
    updateCommentPreview(e.target.closest('[data-comment-editor]'));
});
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-compose-comment]'))
    updateCommentPreview(e.target.closest('[data-comment-editor]'), true);
});
function renderTasks(job) {
  if (!job.tasks?.length) return '';
  const labels = {
    like: '좋아요',
    follow: '팔로우',
    comment: '댓글',
    form: '응모 폼',
    manual: '직접 수행',
  };
  const status = {
    pending: '대기',
    review: '확인 필요',
    approved: '위임됨',
    attempted: '결과 불명',
    verified: '화면 확인',
    manual_reported: '사용자 완료 보고',
  };
  const pending = job.tasks.filter((t) => ['review', 'attempted'].includes(t.state));
  return `<div class="inbox"><h4>참여 과제</h4><ol>${job.tasks.map((t) => `<li>${esc(labels[t.kind])} · ${esc(status[t.state])} — ${esc(t.instruction)}${t.proof ? `<small> · ${esc(t.proof.quote)}</small>` : ''}</li>`).join('')}</ol>${!job.archivedAt && ['needs_user', 'submission_unknown'].includes(job.status) && pending.length ? `<form data-task-review="${esc(job.id)}">${pending.map((t) => `<fieldset><legend>${esc(labels[t.kind])} · ${esc(t.instruction)}</legend>${safeLink(t.url, '과제 대상 열기')}<blockquote>${esc(t.quote)}</blockquote>${t.permitted && !t.attempt ? `<p class="hint">${t.route === 'instagram_browser' ? '인스타 브라우저 대행입니다. 이 작업에서 확인한 계정·대상·문구만 실행하며 플랫폼 공식 승인으로 표시하지 않습니다.' : '자동 실행 허용 근거가 등록된 경로입니다. 아래 내용은 이 작업·대상에만 적용합니다.'}</p>${t.preview ? `<p><strong>실행 계정</strong> @${esc(t.preview.actor)} · <strong>대상 계정</strong> @${esc(t.preview.subject)}</p>` : t.route === 'instagram_browser' ? '<p class="hint">현재 계정·대상 확인이 필요합니다. 아래 ‘새 화면에서 재개’를 눌러 다시 확인하세요.</p>' : ''}<input type="hidden" name="mode-${esc(t.id)}" value="approve">${t.kind === 'comment' ? renderCommentEditor(t) : ''}` : `<p class="hint">자동 실행 ${t.attempt ? '결과가 불명확합니다' : '허용 경로가 확인되지 않았습니다'}. 직접 확인한 결과만 기록하세요.</p><input type="hidden" name="mode-${esc(t.id)}" value="manual"><label>직접 수행·확인한 결과<textarea name="evidence-${esc(t.id)}" required maxlength="2000"></textarea></label>`}</fieldset>`).join('')}<button type="submit" ${state.busy || pending.some((t) => t.route === 'instagram_browser' && t.permitted && !t.attempt && !t.preview) ? 'disabled' : ''}>과제 확인을 한 번에 저장하고 계속</button></form>` : ''}</div>`;
}
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!form.matches('[data-task-review]')) return;
  void guard(async () => {
    const job = state.jobs.find((j) => j.id === form.dataset.taskReview),
      values = new FormData(form);
    await api(`/api/jobs/${job.id}/task`, {
      items: job.tasks
        .filter((t) => ['review', 'attempted'].includes(t.state))
        .map((t) => ({
          taskId: t.id,
          mode: values.get(`mode-${t.id}`),
          text: values.get(`text-${t.id}`) || undefined,
          evidence: values.get(`evidence-${t.id}`) || undefined,
          personalAnswers: t.draftPreparation?.commentPlan
            ? Object.fromEntries(
                t.draftPreparation.commentPlan.inputs.map((q) => [
                  q.id,
                  values.get(`personal-${t.id}-${q.id}`) || '',
                ]),
              )
            : undefined,
        })),
    });
  })(event);
});
$('selection-policy-form').onsubmit = guard(async () => {
  const f = $('selection-policy-form').elements;
  const facts = f.facts.value
    .split('\n')
    .filter((v) => v.trim())
    .map((line) => {
      const i = line.indexOf('=');
      if (i < 1 || !line.slice(i + 1).trim())
        throw new Error('자격은 항목=값 형식으로 적어 주세요.');
      return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
    });
  await api('/api/selection-policy', {
    facts,
    mode: f.mode.value,
    prizeMode: f.prizeMode.value,
    personalResponses: f.personalResponses.value,
    newConnections: f.newConnections.value,
    registrations: f.registrations.value,
    allowedTasks: [
      ...$('selection-policy-form').querySelectorAll('[name=allowedTasks]:checked'),
    ].map((el) => el.value),
    discoveryCalls: +f.discoveryCalls.value,
    discoveryTokens: f.discoveryTokens.value ? +f.discoveryTokens.value : null,
    entryTokens: f.entryTokens.value ? +f.entryTokens.value : null,
    preferredPrizes: f.preferredPrizes.value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    excludedTypes: [...f.excludedTypes.selectedOptions].map((o) => o.value),
    maxMinutes: +f.maxMinutes.value,
    maxQuestions: +f.maxQuestions.value,
    maxCalls: +f.maxCalls.value,
    maxSwitches: +f.maxSwitches.value,
    switchOnBurden: f.switchOnBurden.checked,
  });
  selectionLoaded = false;
  await refresh();
  toast('기회 선택 기준을 저장했습니다.');
});
$('instagram-browser-form').onsubmit = guard(async () => {
  await api('/api/instagram-browser', { enabled: $('instagram-browser-enabled').checked });
  toast('인스타 브라우저 대행 설정을 저장했습니다. 게시 내용과 대상은 작업별로 확인합니다.');
});
$('task-permission-form').onsubmit = guard(async () => {
  const data = new FormData($('task-permission-form'));
  await api('/api/task-permission', {
    taskUrl: data.get('taskUrl'),
    sourceUrl: data.get('sourceUrl'),
    basis: data.get('basis'),
    kinds: data.getAll('kinds'),
    evidence: data.get('evidence'),
    expires: Date.now() + Number(data.get('days')) * 86400000,
  });
  toast('서비스 허용 근거를 등록했습니다. 실제 과제 대상과 게시 내용 승인은 별도입니다.');
});
async function loadReport() {
  const query = new URLSearchParams(
    [...new FormData($('report-filter'))].filter(([, value]) => value),
  ).toString();
  const data = await api(`/api/report?${query}`);
  $('report-note').textContent = data.notes;
  $('report-download').href = `/api/report.csv?${query}`;
  $('report-groups').innerHTML =
    `<table><thead><tr><th>출처 · 유형</th><th>접수 / 미확인</th><th>무효 / 누락</th><th>사람 조작</th><th>실행 / 답변 대기</th><th>AI 계측 호출 · 토큰</th><th>추정 USD</th><th>당첨 / 수령</th><th>실현 KRW</th></tr></thead><tbody>${data.groups.map((g) => `<tr><td>${esc(g.source)}<br><small>${esc({ survey: '설문', quiz: '퀴즈', social: 'SNS', mixed: '혼합', other: '기타', discovery: '탐색' }[g.type] || g.type)}</small></td><td>${g.completed} / ${g.unknown}</td><td>${g.invalid} / ${g.missed}</td><td>${g.humanMs === null ? '미계측' : (g.humanMs / 60000).toFixed(1) + '분'}<br><small>미계측 ${g.unmeasuredHuman}건</small></td><td>${g.activeSamples ? (g.activeMs / 60000).toFixed(1) + '분' : '미계측'} / ${(g.waitingMs / 60000).toFixed(1)}분</td><td>${g.calls}회 · ${(g.inputTokens + g.outputTokens).toLocaleString()}${g.unmeteredJobs ? `<br><small>원장 이전 기록 ${g.unmeteredJobs}건 포함</small>` : ''}</td><td>${g.estimatedUsd === null ? '미산정' : '$' + g.estimatedUsd.toFixed(4)}<br><small>단가 미산정 ${g.unpricedCalls}회</small></td><td>${g.won} / ${g.received}</td><td>${g.realizedKrw.toLocaleString()}원</td></tr>`).join('')}</tbody></table>`;
  $('quality-records').innerHTML = data.rows
    .filter((r) => r.qualityReason)
    .map(
      (r) =>
        `<p><strong>${esc(r.title)}</strong> · ${esc({ valid: '유효', invalid: '무효', missed: '누락', unconfirmed: '미확인' }[r.quality])}<br>${esc(r.qualityReason)}</p>`,
    )
    .join('');
}
$('report-filter').onsubmit = guard(loadReport);
$('quality-form').onsubmit = guard(async () => {
  await api('/api/quality', Object.fromEntries(new FormData($('quality-form'))));
  await loadReport();
  toast('확인 근거를 기록했습니다. 접수 상태는 변경하지 않습니다.');
});
const activitySession = crypto.randomUUID();
let activitySequence = 0,
  activityJob,
  lastActivity = 0;
for (const eventName of ['pointerdown', 'keydown', 'input'])
  document.addEventListener(eventName, (event) => {
    const target = event.target.closest('[data-activity-job], [data-inbox], [data-job]');
    if (!target) return;
    activityJob = target.dataset.activityJob || target.dataset.inbox || target.dataset.job;
    lastActivity = Date.now();
  });
setInterval(() => {
  if (!state || !activityJob) return;
  void api('/api/activity', {
    jobId: activityJob,
    sessionId: activitySession,
    sequence: ++activitySequence,
    active:
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      Date.now() - lastActivity < 30000,
  }).catch(() => {});
}, 5000);

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-revoke-permission]');
  if (button)
    void guard(async () => {
      await api('/api/task-permission/revoke', { taskUrl: button.dataset.revokePermission });
      toast('이 경로의 자동 실행 허용 근거를 철회했습니다.');
    })(event);
});

$('connections-check').onclick = guard(async () => {
  await api('/api/connections/check', {
    ids: (state.connections || [])
      .filter((c) => ['instagram', 'naver', 'google'].includes(c.id))
      .map((c) => c.id),
  });
  await refresh();
  toast('로그인 상태 확인 결과를 저장했습니다.');
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-check-site],#needed-connections-check');
  if (!button) return;
  void guard(async () => {
    button.disabled = true;
    try {
      await api('/api/connections/check', {
        ids: button.dataset.checkSite
          ? [button.dataset.checkSite]
          : state.connections
              .filter((c) => c.requiredBy.length)
              .slice(0, 10)
              .map((c) => c.id),
      });
      await refresh();
      toast('연결 상태를 다시 확인했습니다.');
    } finally {
      button.disabled = false;
    }
  })();
});

let rewardInboxLimit = 20;
let shownRewardNoticeIds = [];
let telegramCandidateKey = '';
let telegramPending = '';
let telegramFeedback;
function telegramAction(progress, fn) {
  return async (event) => {
    event?.preventDefault();
    if (telegramPending || state.telegram?.busy) return;
    telegramPending = progress;
    telegramFeedback = undefined;
    renderTelegramAndInbox();
    try {
      telegramFeedback = await fn();
    } catch (error) {
      telegramFeedback = { message: error.message, error: true };
    } finally {
      await refresh().catch(() => {});
      telegramPending = '';
      renderTelegramAndInbox();
    }
  };
}
const deliveryLabels = {
  sending: '전송 중',
  sent: '텔레그램 접수 확인',
  unknown: '전송 결과 미확인 · 자동 재전송 안 함',
  failed: '전송 중단',
  retry: '요청 제한 · 재시도 대기',
};
function renderTelegramAndInbox() {
  const t = state.telegram || {};
  const busy = !!telegramPending || t.busy;
  const connection = t.connection;
  const phase = connection?.phase === 'webhook' ? '기존 연결 확인' : '봇 정보 확인';
  const feedback = telegramPending
    ? { message: telegramPending }
    : telegramFeedback ||
      (connection?.state === 'failed'
        ? {
            error: true,
            message: `${phase} 실패: ${connection.message || connection.code}${!t.configured ? ' 토큰은 저장되지 않았습니다. 입력 후 다시 시도해 주세요.' : ''}`,
          }
        : connection?.state === 'checking'
          ? { message: `${phase} 중…` }
          : connection?.state === 'ready' && t.pairUrl
            ? {
                message:
                  '토큰 저장 완료. 아래 연결 링크를 열어 본인 텔레그램에서 시작(Start)을 누르세요.',
              }
            : undefined);
  const status = $('telegram-action-status');
  status.hidden = !feedback;
  status.textContent = feedback?.message || '';
  status.className = 'telegram-feedback' + (feedback?.error ? ' error' : '');
  status.setAttribute('role', feedback?.error ? 'alert' : 'status');
  const pairForm = $('telegram-pair-form');
  pairForm.querySelector('button').disabled = busy;
  pairForm.querySelector('button').textContent = busy
    ? '텔레그램 확인 중…'
    : '토큰 저장·연결 링크 만들기';
  pairForm.elements.token.readOnly = busy;
  const candidateLabel = t.candidate || t.recipient || '';
  const candidateKey = t.confirmation || '';
  if (candidateKey !== telegramCandidateKey) {
    $('telegram-confirm').checked = false;
    telegramCandidateKey = candidateKey;
  }
  $('telegram-connection-status').textContent =
    `${t.enabled ? '알림 사용 중' : t.configured ? '연결 준비·알림 중지' : '봇 미연결'}${t.username ? ' · @' + t.username : ''}${candidateKey ? ' · 수신 대화: ' + candidateLabel : ''}${t.pairExpires ? ' · 연결 링크 만료: ' + new Date(t.pairExpires).toLocaleTimeString() : ''}`;
  $('telegram-pair-link').hidden = !t.pairUrl;
  if (t.pairUrl) $('telegram-pair-link').href = t.pairUrl;
  else $('telegram-pair-link').removeAttribute('href');
  $('telegram-find').disabled = !t.pairUrl || busy;
  $('telegram-activate').disabled = !candidateKey || busy || !$('telegram-confirm').checked;
  $('telegram-send-pending').disabled = !t.enabled || busy;
  $('telegram-pause').disabled = !t.enabled || busy;
  $('telegram-disconnect').disabled = !t.configured || busy;
  $('telegram-deliveries').innerHTML =
    (t.deliveries || [])
      .map(
        (d) =>
          `<p>${esc(new Date(d.at).toLocaleString())} · ${d.test ? '연결 테스트' : d.noticeIds.length + '개 알림'} · ${esc(deliveryLabels[d.status] || d.status)}${d.code ? '<br><small>' + esc(d.code) + '</small>' : ''}</p>`,
      )
      .join('') || '<p class="hint">아직 전송 내역이 없습니다.</p>';
  const notices = state.rewardNotices || [];
  const filtered =
    $('reward-inbox-filter').value === 'unread' ? notices.filter((n) => !n.readAt) : notices;
  const shown = filtered.slice(0, rewardInboxLimit);
  shownRewardNoticeIds = shown.map((n) => n.id);
  $('reward-inbox-count').textContent =
    `안 읽음 ${notices.filter((n) => !n.readAt).length}개 · 전체 ${notices.length}개`;
  $('reward-inbox').innerHTML =
    shown
      .map(
        (n) =>
          `<article class="event-card"><span class="pill ${n.readAt ? '' : 'warning'}">${n.readAt ? '읽음' : '안 읽음'}</span><h4>${esc(n.label)}</h4><p>${esc(n.title)}</p><p class="hint">${esc(new Date(n.createdAt).toLocaleString())} · ${n.active ? '현재 확인할 내용' : '지난 알림'}<br>텔레그램: ${esc(deliveryLabels[t.deliveryByNotice?.[n.id]] || (n.active && t.enabled ? '전송 대기' : '미전송'))}</p><div class="card-actions">${n.active && n.kind === 'dm_review' ? '<a href="#dm-reviews">당첨 안내와 행사 연결 확인</a>' : ''}${n.active && n.kind === 'reply' && state.outcomes.find((o) => o.eventId === n.eventId)?.dmChecks?.some((d) => d.state === 'won') ? `<button data-dm-reply="${esc(n.eventId)}">수신 안내·회신 검토</button>` : ''}<button data-outcome="${esc(n.eventId)}">결과·후속 처리 열기</button>${n.readAt ? '' : `<button data-notice-read="${esc(n.id)}">읽음으로 표시</button>`}</div></article>`,
      )
      .join('') ||
    '<p class="hint">표시할 알림이 없습니다. 당첨·회신·수령 알림이 생기면 여기에 보관합니다.</p>';
  $('reward-inbox-more').hidden = filtered.length <= rewardInboxLimit;
  $('reward-inbox-read').disabled = !shown.some((n) => !n.readAt);
}
$('telegram-pair-form').onsubmit = telegramAction(
  '봇 정보와 기존 연결을 확인하는 중입니다…',
  async () => {
    const input = $('telegram-pair-form').elements.token;
    const token = input.value.trim();
    await api('/api/telegram/pair', { token });
    input.value = '';
    return {
      message:
        '토큰 저장 완료. 아래 연결 링크를 열어 본인 텔레그램에서 시작(Start)을 누르세요. 아직 알림은 꺼져 있습니다.',
    };
  },
);
$('telegram-find').onclick = telegramAction('본인 대화를 확인하는 중입니다…', async () => {
  const r = await api('/api/telegram/find', {});
  return {
    message: r.candidate
      ? '개인 대화를 찾았습니다. 본인 대화인지 확인해 주세요.'
      : '시작 메시지가 아직 없습니다. 연결 링크에서 시작 버튼을 누른 뒤 다시 확인하세요.',
  };
});
$('telegram-confirm').onchange = () => renderTelegramAndInbox();
$('telegram-activate').onclick = telegramAction('테스트 알림을 전송하는 중입니다…', async () => {
  if (!$('telegram-confirm').checked) return;
  const r = await api('/api/telegram/activate', {
    confirmPersonalChat: true,
    confirmation: state.telegram.confirmation,
  });
  return {
    message: r.enabled
      ? '텔레그램이 테스트 메시지를 접수했습니다. 알림을 사용합니다.'
      : '테스트 발송을 확인하지 못했습니다. 전송 내역을 확인하세요.',
    error: !r.enabled,
  };
});
for (const action of ['pause', 'disconnect', 'send-pending'])
  $('telegram-' + action).onclick = telegramAction('요청을 처리하는 중입니다…', async () => {
    await api('/api/telegram/' + action, {});
    return {
      message:
        action === 'pause'
          ? '텔레그램 알림을 중지했습니다.'
          : action === 'disconnect'
            ? '텔레그램 연결을 해제했습니다.'
            : '대기 알림을 확인했습니다. 아래 전송 내역에서 결과를 확인하세요.',
    };
  });
$('reward-inbox-filter').onchange = () => {
  rewardInboxLimit = 20;
  renderTelegramAndInbox();
};
$('reward-inbox-more').onclick = () => {
  rewardInboxLimit += 20;
  renderTelegramAndInbox();
};
$('reward-inbox-read').onclick = guard(async () => {
  await api('/api/reward-notices/read', { ids: shownRewardNoticeIds });
  await refresh();
});
$('reward-inbox').onclick = guard(async (e) => {
  const b = e.target.closest('[data-notice-read]');
  if (!b) return;
  await api('/api/reward-notices/read', { ids: [b.dataset.noticeRead] });
  await refresh();
});
