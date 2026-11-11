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
const terminalJob = (job) => ['completed', 'stopped'].includes(job.status);
const canAnswerInbox = (job) =>
  !job.archivedAt &&
  job.status === 'needs_user' &&
  job.autonomy?.inbox &&
  (job.autonomy.synthetic || state.autonomy.revision === job.autonomy.revision);
function jobNote(job) {
  return job.status === 'stopped' &&
    job.note === '브라우저를 직접 조작할 수 있습니다. 재개 시 새 화면부터 확인합니다.'
    ? '작업을 중지했습니다. 추가 답변이나 재개 없이 실행 기록만 보관합니다.'
    : job.note;
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
      await refresh().catch(() => {});
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
    ${renderReceiptCheck(e.receiptCheck)}${renderConsents(e.consents)}<div class="card-actions"><button data-outcome="${esc(e.eventId)}">결과·경품 관리</button>${safeLink(e.sourceUrl, '이벤트 원문')}${safeLink(e.entryUrl, '참여 페이지')}</div></article>`,
        )
        .join('')
    : `<div class="empty">${query ? '검색 결과가 없습니다.' : '완료한 응모가 여기에 모입니다.'}</div>`;
}
function renderEvents() {
  if (!state) return;
  const filter = $('event-filter').value,
    query = $('event-search').value.trim().toLocaleLowerCase();
  const rows = state.events
    .filter((e) => `${e.title} ${e.organizer} ${e.prize}`.toLocaleLowerCase().includes(query))
    .filter(
      (e) =>
        filter === 'all' ||
        (filter === 'unfinished'
          ? !e.lifecycle?.hiddenByDefault && e.submissionState !== 'completed'
          : ['manual', 'dropped', 'unknown'].includes(filter)
            ? filter === 'unknown'
              ? e.lifecycle?.unknown && e.submissionState !== 'completed'
              : e.lifecycle?.status === filter
            : filter === 'stopped'
              ? ['stopped', 'failed', 'held'].includes(e.lifecycle?.status)
              : filter === 'completed'
                ? e.submissionState === 'completed'
                : filter === 'eligible'
                  ? !e.submissionState &&
                    !e.lifecycle?.hiddenByDefault &&
                    e.assessment?.state === 'eligible' &&
                    !e.preparationReasons?.length
                  : !e.submissionState &&
                    !e.lifecycle?.hiddenByDefault &&
                    (e.assessment?.state !== 'eligible' || !!e.preparationReasons?.length)),
    );
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
          const ended = e.deadlineState === 'ended';
          const blocked =
            (e.assessment && e.assessment.state !== 'eligible') ||
            e.deadlineState !== 'available' ||
            e.blockers.length ||
            e.preparationReasons?.length ||
            e.submissionState;
          return `<article class="event-card"><div class="card-top"><span class="pill ${blocked ? 'warning' : ''}">${e.lifecycle && e.lifecycle.status !== 'candidate' ? esc(e.lifecycle.label) : e.submissionState === 'completed' ? '응모 완료' : ended ? '마감' : blocked ? '조건 확인 필요' : `검토 우선순위 ${e.assessment?.score ?? e.score}`}</span><small>${esc(e.organizer)}</small></div><h3>${esc(e.title)}</h3><p class="prize">${esc(e.prize)}</p>${e.lifecycle?.reason ? `<p class="entry-reason">${esc(e.lifecycle.reason)}</p>` : ''}<dl><dt>마감</dt><dd>${e.deadline ? esc(new Date(e.deadline).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })) : e.deadlineDate ? `${esc(e.deadlineDate)} · 시각 미표기` : '확인되지 않음'}</dd><dt>선정</dt><dd>${e.winners ? `${e.winners}명` : '인원 미확인'} · 추정 소요 ${e.effortMinutes}분</dd></dl><div class="candidate-reasons"><strong>${e.preparationReasons?.length ? '자동 준비 보류 이유' : '선정 이유'}</strong><ul>${[...new Set([...(e.assessment?.reasons || []), ...(e.preparationReasons || [])])].map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${e.assessment?.adjustments?.length ? '<a href="#selection-policy">운영 탭에서 조건 조정</a>' : ''}</div><ul>${e.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${e.blockers.length ? `<p class="warning-text">${e.blockers.map(esc).join(' · ')}</p>` : ''}<details><summary>추천 근거와 원문 증거</summary><p>${e.scoreReasons.map(esc).join(' · ')}</p><blockquote>${esc(e.evidenceQuote)}</blockquote><p>${e.evidenceKind === 'image' ? '이미지에서 해석한 조건 · 실행 전 확인 필요' : '원문 텍스트 확인'}</p><a href="/evidence/${esc(e.screenshot)}" target="_blank">확인 당시 화면 ↗</a></details><details class="event-review"><summary>조건 재검토</summary><form data-event-review="${esc(e.id)}"><label>확인한 참여 주소<input name="entryUrl" type="url" required value="${esc(e.entryUrl)}"></label><label>확인한 마감 날짜<input name="deadlineDate" type="date" value="${esc(e.deadlineDate || '')}"></label><label>아직 해결되지 않은 조건 (한 줄씩)<textarea name="blockers">${esc(e.blockers.join('\n'))}</textarea></label><label>원문에서 확인한 내용<textarea name="note" required minlength="5" placeholder="기존 조건을 바꾸는 근거를 적어주세요."></textarea></label><button type="submit" ${state.busy ? 'disabled' : ''}>검토 내용 저장</button></form>${e.reviews?.length ? `<p class="hint">최근 검토: ${esc(e.reviews.at(-1).note)}</p>` : ''}</details><div class="card-actions">${safeLink(e.sourceUrl, '확인한 원문')}${safeLink(e.entryUrl, '참여 페이지')}<button data-apply="${esc(e.id)}" ${blocked || state.busy ? 'disabled' : ''}>${e.submissionState === 'completed' ? '응모 완료' : e.submissionState ? esc(e.lifecycle?.label || '기존 작업 확인') : '응모 준비'}</button>${e.lifecycle?.canManage ? `<button data-entry-manage="${esc(e.id)}" ${state.busy ? 'disabled' : ''}>처리 방법 선택</button>` : ''}</div></article>`;
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
function renderInbox(job) {
  const a = job.autonomy;
  if (!a) return '';
  const m = a.metrics;
  const metrics = `<p class="hint">묶음 ${m.batches}회 · 입력 검증 ${m.fields}개 · 답변 재사용 ${m.reused}개 · 확인 요청 ${m.inboxBatches}회 · 자동 복구 ${m.recoveries}회 · 모델 ${(m.modelMs / 1000).toFixed(1)}초 / 관찰·입력 ${(m.browserMs / 1000).toFixed(1)}초</p>${renderConsents(a.consents)}`;
  if (job.archivedAt || terminalJob(job)) return metrics;
  const changed = !a.synthetic && state.autonomy.revision !== a.revision;
  if (changed && !['completed', 'stopped'].includes(job.status))
    return (
      metrics +
      `<p class="warning-text">설정이 변경되어 기존 위임이 만료되었습니다.</p><button data-action="delegation" data-job="${job.id}">이 작업에 새 정책 적용</button>`
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
  const uncertainStage = box.final && /^(다음|next|continue)$/i.test(box.buttonLabel || '');
  return (
    metrics +
    `<div class="approval"><h3>확인함 · ${box.final ? (uncertainStage ? '이 단계 전송 검토' : '최종 제출') : `${box.items.length}개 답변`}</h3><form data-inbox="${job.id}" data-inbox-id="${box.id}">${box.final ? `<p>${uncertainStage ? '이 단계의 답변을 전송합니다. 마지막 단계인지 확인되지 않았으며, 추가 문항이 나오면 계속 진행합니다.' : '입력 내용을 확인한 뒤 이 응모의 최종 제출을 허용합니다.'}</p>${renderFormReview(box.review, job.currentUrl)}<button type="submit" class="primary">${uncertainStage ? '확인한 답변 전송하고 계속' : '최종 제출하고 결과 확인'}</button>` : box.items.map((q) => `<fieldset data-question="${esc(q.id)}"><legend>${esc(q.label)}</legend>${q.description ? `<details><summary>질문 설명·동의 내용</summary><p>${esc(q.description)}</p></details>` : ''}${q.kind === 'file' ? `<input name="${esc(q.id)}" type="file" accept=".png,.jpg,.jpeg,.pdf" ${q.required && !q.picker ? 'required' : ''}>${q.picker ? `<label>또는 Drive에서 선택할 정확한 파일명<input name="drive-${esc(q.id)}" maxlength="180" placeholder="같은 이름이 여러 개면 직접 선택이 필요합니다"></label>` : ''}<label class="check"><input type="checkbox" name="upload-${esc(q.id)}" ${q.required ? 'required' : ''}>선택한 실제 파일을 ${q.picker ? 'Google Drive 및 ' : ''}이 응모 주최자에게 첨부하는 데 동의합니다 (기기 파일 최대 5MB).</label>` : q.kind === 'rank' ? q.options.map((_, i) => `<label>${i + 1}순위<select name="${esc(q.id)}" required><option value="">선택</option>${q.options.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select></label>`).join('') : q.kind === 'text' ? `<input name="${esc(q.id)}" ${q.required ? 'required' : ''} maxlength="2000" autocomplete="off">` : q.options.map((o) => `<label class="check"><input type="${q.multiple ? 'checkbox' : 'radio'}" name="${esc(q.id)}" value="${esc(o.id)}" ${!q.multiple && q.required ? 'required' : ''}>${esc(o.label)}</label>`).join('')}${q.recommended ? `<p class="hint">추천: ${q.recommended.map(esc).join(', ')}</p>` : `<p class="hint">${q.category === 'consent' ? esc(q.reason) : '저장된 답이 없어 직접 확인이 필요합니다.'}</p>`}</fieldset>`).join('') + `<button type="button" data-recommend="${job.id}">추천 답변 모두 선택</button><label class="check"><input type="checkbox" name="remember"> 이 사이트의 같은 질문에 답변 재사용${a.synthetic ? ' (합성 테스트에서는 저장하지 않음)' : ''}</label><button class="primary" type="submit">한 번에 답변하고 재개</button>`}</form>${!box.final && box.items.some((q) => q.category === 'knowledge') && (a.researchRetries || 0) < 2 ? `<button type="button" data-action="retry-research" data-job="${job.id}">공개 근거 다시 찾기</button>` : ''}</div>`
  );
}
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
  return `<details class="receipt-check"><summary>제출 결과 판정 · ${esc(labels[check.outcome] || '미확인')}</summary><p>${esc(check.reason)}</p><p class="hint">${check.method === 'ai' ? 'AI 의미 검토' : '명확한 규칙으로 판정'} · ${esc(new Date(check.at).toLocaleString('ko-KR'))}</p>${check.signals.map((s) => `<div class="notification-note"><strong>${esc({ response: '서버 응답', dialog: '브라우저 알림', page: '화면' }[s.kind])} · ${esc(labels[s.outcome] || '미확인')}</strong>${s.status ? `<p>HTTP ${esc(s.status)}</p>` : ''}${s.codes?.length ? `<p>응답 코드: ${s.codes.map(esc).join(', ')}</p>` : ''}${s.receiptNumbers?.length ? `<p>접수번호: ${s.receiptNumbers.map(esc).join(', ')}</p>` : ''}${s.message ? `<blockquote>${esc(s.message)}</blockquote>` : ''}</div>`).join('')}</details>`;
}
function renderOutcome(j) {
  if (!j.uncertain && !j.holdNote && !j.archivedAt) return '';
  return `<div class="outcome-note">${j.archivedAt ? '<strong>보관한 작업 · 자동 실행 안 함</strong>' : ''}${j.uncertain ? '<strong>접수 결과 미확인 · 재응모 잠금 유지</strong><p>완료나 실패가 확정된 상태가 아닙니다. 중복 제출을 막기 위해 자동 재시도하지 않습니다.</p>' : ''}${j.holdNote ? `<p class="consent-notice">${esc(j.holdNote)}</p>` : ''}${j.uncertain ? '<p class="hint">접수 증거를 다시 확인하거나, 실제 미제출을 확인한 뒤 현재 화면에서 이어갈 수 있습니다. 이어갈 화면이 없다면 미확인 상태로 보관할 수 있습니다.</p>' : ''}</div>`;
}
function renderJobActions(j) {
  const b = (action, label, disabled = false) =>
    `<button data-action="${action}" data-job="${j.id}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  if (j.archivedAt)
    return `<div class="card-actions">${b('unarchive', '진행 목록으로 복원', state.busy)}</div>`;
  if (j.status === 'running')
    return `<div class="card-actions">${b('pause', '일시정지 · 직접 조작')}${b('stop', '중지')}</div>`;
  if (['completed', 'stopped'].includes(j.status)) return '';
  return `<div class="card-actions">${j.status === 'approval' ? b('pause', '취소 · 직접 조작') : j.autonomy?.inbox ? '' : b('resume', j.steps >= j.maxSteps ? '20회 추가해 재개' : '새 화면에서 재개', state.busy)}${['paused', 'failed', 'needs_user', 'submission_unknown'].includes(j.status) ? b('resume-current', '현재 브라우저 화면에서 재개', state.busy) : ''}${j.uncertain ? b('verify-result', '저장된 접수 증거 다시 확인', state.busy) + b('reconcile', '미제출 직접 확인', state.busy) : ''}${b('archive', j.uncertain ? '미확인 상태로 보관' : '진행 목록에서 보관', state.busy)}</div>`;
}
function render() {
  renderSelection();
  renderOperations();
  renderOutcomeSummary();
  $('result-attention').innerHTML = $('outcome-alerts').innerHTML;
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
          `<article data-activity-job="${esc(j.id)}" class="job" id="job-${esc(j.id)}"><div class="section-head"><div><span class="pill ${j.status === 'running' ? 'active' : j.status === 'submission_unknown' ? 'warning' : ''}">${esc(statuses[j.status])}</span><h3>${esc({ result: '당첨 발표 확인', discover: '이벤트 탐색', apply: '이벤트 응모', demo: '합성 화면 테스트', autonomy_demo: '자율 설문 테스트' }[j.kind])}</h3></div><small>${esc(j.provider.kind === 'chatgpt' ? 'ChatGPT 플랜' : 'OpenAI API')} · ${esc(j.provider.model)}</small></div>${j.eventId ? `<p class="job-event-title">${esc(state.events.find((e) => e.id === j.eventId)?.title || '')}</p>` : ''}<p>${esc(jobNote(j))}</p>${renderOutcome(j)}${renderReceiptCheck(j.receiptCheck)}<div class="job-meta">판단 ${j.steps}/${j.maxSteps}회 · 입력 ${j.inputTokens.toLocaleString()} / 출력 ${j.outputTokens.toLocaleString()} 토큰</div>${renderReadTraces(j)}${renderTasks(j)}${renderInbox(j)}${j.approval && j.status === 'approval' && !j.archivedAt ? `<div class="approval"><strong>${j.approval.kind === 'content' ? '입력 내용 확인' : '외부 동작 확인'}</strong><p>${esc(j.approval.url)}</p><p>대상: ${esc(j.approval.target?.label || '화면의 선택 좌표')} ${j.approval.target?.href ? safeLink(j.approval.target.href, '이동 주소') : ''}</p><p>동작: ${esc(j.approval.action.action)} · ${esc(j.approval.action.reason)}</p>${j.approval.action.text ? `<pre>${esc(j.approval.action.text)}</pre>` : ''}${renderFormReview(j.approval.form, j.approval.url)}<p class="hint">이 내용과 현재 화면에 한해 허용됩니다. 화면이 바뀌면 다시 확인합니다.</p><button class="primary" data-action="approve" data-job="${j.id}" data-approval="${j.approval.id}">확인한 동작 실행</button></div>` : ''}<details class="evidence"><summary>관찰 화면과 실행 내역</summary>${j.screenshot ? `<a href="/evidence/${esc(j.screenshot)}" target="_blank"><img loading="lazy" src="/evidence/${esc(j.screenshot)}" alt="이 작업의 최근 브라우저 관찰 화면"></a>` : '<p>아직 관찰 화면이 없습니다.</p>'}<ol>${j.history.map((h) => `<li>${esc(h.reason)} <small>${esc(h.action)}</small></li>`).join('')}</ol></details>${!j.autonomy && !j.archivedAt && ['needs_user', 'paused'].includes(j.status) ? `<details><summary>내 답변 전달하기</summary><form data-job-context="${esc(j.id)}"><p class="hint">현재 질문에 대한 실제 답을 적어주세요. 비밀번호·연락처는 전용 브라우저에 직접 입력하세요.</p><textarea name="text" required maxlength="2000" placeholder="질문과 답변을 함께 적어주세요."></textarea><button type="submit">답변 저장 후 재개</button></form></details>` : ''}${renderJobActions(j)}</article>`,
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
  const recommend = event.target.closest('[data-recommend]');
  if (recommend) {
    const box = state.jobs.find((j) => j.id === recommend.dataset.recommend).autonomy.inbox;
    const form = recommend.closest('form');
    for (const q of box.items.filter((q) => q.recommended)) {
      let rankIndex = 0;
      for (const el of form.elements) {
        if (el.name !== q.id) continue;
        if (el.type === 'checkbox' || el.type === 'radio')
          el.checked = q.recommended.includes(el.value);
        else el.value = q.recommended[q.kind === 'rank' ? rankIndex++ : 0] || '';
      }
    }
  }
});
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-login],[data-forget],[data-recommend],[data-external]'))
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
    });
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
function renderOperations() {
  if (!state.operations) return;
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

function outcomeLabel(eventId) {
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
  const rows = state.outcomes || [],
    won = rows.filter((o) => o.status === 'won');
  const realized = won.reduce(
    (sum, o) => sum + (o.reward?.status === 'used' ? o.reward.realizedValue : 0),
    0,
  );
  $('outcome-summary').textContent =
    `접수 ${state.completedEntries.length}건 · 확인한 당첨 ${won.length}건 · 수령 ${won.filter((o) => ['received', 'used'].includes(o.reward?.status)).length}건 · 실현 가치 ${realized.toLocaleString()}원`;
  $('outcome-alerts').innerHTML = (state.outcomeAlerts || [])
    .map(
      (a) =>
        `<p><button data-outcome="${esc(a.eventId)}">${esc(a.title)}</button> ${esc(a.message)}</p>`,
    )
    .join('');
}
document.addEventListener('click', (event) => {
  const b = event.target.closest('[data-outcome]');
  if (!b) return;
  const e = state.completedEntries.find((e) => e.eventId === b.dataset.outcome);
  const o = state.outcomes.find((o) => o.eventId === e.eventId),
    form = $('outcome-form');
  form.reset();
  form.hidden = false;
  $('reward-code').textContent = '';
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
  };
  for (const [k, v] of Object.entries(values)) form.elements.namedItem(k).value = v;
  form.elements.autoCheck.checked = !!o?.autoCheck;
  $('outcome-proof').innerHTML = o?.check
    ? `<blockquote>${esc(o.check.quote)}</blockquote><p>${safeLink(o.check.url, '확인한 발표')} · ${esc(new Date(o.check.at).toLocaleString())}</p><a href="/evidence/${esc(o.check.screenshot)}" target="_blank">확인 당시 화면 ↗</a>`
    : '';
  location.hash = 'rewards';
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
    reward:
      f.get('status') === 'won'
        ? {
            name: f.get('rewardName'),
            status: f.get('rewardStatus'),
            expiresOn: f.get('expiresOn') || null,
            faceValue: Number(f.get('faceValue')),
            realizedValue: Number(f.get('realizedValue')),
            code: f.get('code'),
          }
        : undefined,
  });
  $('outcome-form').elements.code.value = '';
  $('reward-code').textContent = '';
  toast('결과·경품을 저장했습니다.');
});
$('check-outcome').onclick = guard(async () => {
  await api('/api/outcomes/check', {
    eventId: $('outcome-form').elements.eventId.value,
    provider: requireChoice(),
  });
  toast('저장된 공식 발표 주소를 읽는 작업을 시작했습니다.');
});
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
  return `<div class="hint draft-preparation"><strong>${draft.state === 'ready' ? 'AI 권장 댓글 · ' + (basis[draft.basis] || '초안') : '댓글 준비 확인 필요'}</strong><p>${esc(draft.reason || '')}</p>${draft.evidenceQuote ? `<blockquote>${esc(draft.evidenceQuote)}</blockquote>` : ''}${draft.sourceUrl ? safeLink(draft.sourceUrl, '답안 근거 열기') : ''}${draft.quiz?.length ? `<details><summary>AI 풀이 기록 · ${draft.quiz.length}문항</summary><ul>${draft.quiz.map((q) => `<li>${esc(q.question)} — 먼저 푼 답: ${esc(q.answer)} · ${q.key ? `공개 정답: ${esc(q.key.answer)} (${q.answer === q.key.answer ? '일치' : '불일치'})` : '정답 확인 전'}</li>`).join('')}</ul></details>` : ''}</div>`;
}
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
  return `<div class="inbox"><h4>참여 과제</h4><ol>${job.tasks.map((t) => `<li>${esc(labels[t.kind])} · ${esc(status[t.state])} — ${esc(t.instruction)}${t.proof ? `<small> · ${esc(t.proof.quote)}</small>` : ''}</li>`).join('')}</ol>${!job.archivedAt && ['needs_user', 'submission_unknown'].includes(job.status) && pending.length ? `<form data-task-review="${esc(job.id)}">${pending.map((t) => `<fieldset><legend>${esc(labels[t.kind])} · ${esc(t.instruction)}</legend>${safeLink(t.url, '과제 대상 열기')}<blockquote>${esc(t.quote)}</blockquote>${t.permitted && !t.attempt ? `<p class="hint">${t.route === 'instagram_browser' ? '인스타 브라우저 대행입니다. 이 작업에서 확인한 계정·대상·문구만 실행하며 플랫폼 공식 승인으로 표시하지 않습니다.' : '자동 실행 허용 근거가 등록된 경로입니다. 아래 내용은 이 작업·대상에만 적용합니다.'}</p>${t.preview ? `<p><strong>실행 계정</strong> @${esc(t.preview.actor)} · <strong>대상 계정</strong> @${esc(t.preview.subject)}</p>` : t.route === 'instagram_browser' ? '<p class="hint">현재 계정·대상 확인이 필요합니다. 아래 ‘새 화면에서 재개’를 눌러 다시 확인하세요.</p>' : ''}<input type="hidden" name="mode-${esc(t.id)}" value="approve">${t.kind === 'comment' ? `${renderDraftPreparation(t)}<label>게시할 정확한 내용<textarea name="text-${esc(t.id)}" required maxlength="2000">${esc(t.draft || '')}</textarea></label>` : ''}` : `<p class="hint">자동 실행 ${t.attempt ? '결과가 불명확합니다' : '허용 경로가 확인되지 않았습니다'}. 직접 확인한 결과만 기록하세요.</p><input type="hidden" name="mode-${esc(t.id)}" value="manual"><label>직접 수행·확인한 결과<textarea name="evidence-${esc(t.id)}" required maxlength="2000"></textarea></label>`}</fieldset>`).join('')}<button type="submit" ${state.busy || pending.some((t) => t.route === 'instagram_browser' && t.permitted && !t.attempt && !t.preview) ? 'disabled' : ''}>과제 확인을 한 번에 저장하고 계속</button></form>` : ''}</div>`;
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
