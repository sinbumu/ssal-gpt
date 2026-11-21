import { ServiceError, safeMessage } from './auth.js';
import { ModelOutputError } from './model-output.js';
import type { Job } from './store.js';
import { pendingFormStep } from './form-execution.js';

export type ObservationDiagnostic = {
  at: number;
  stage: 'ready' | 'controls' | 'text' | 'screenshot' | 'finalize';
  code: string;
  attempt: number;
  outcome: 'retrying' | 'recovered' | 'stopped';
};
export type JobNotice = {
  category: 'normal' | 'technical' | 'user';
  title: string;
  reason: string;
  nextAction: string;
  code?: string;
  phase?: string;
  at?: number;
};

// Never persist arbitrary exception messages/stacks, URLs, response bodies or
// browser input values. The returned codes are safe diagnostic categories.
export function observationErrorCode(error: unknown): string {
  if (error instanceof ServiceError) return error.code;
  if (!(error instanceof Error)) return 'browser_observation_failed';
  if (
    /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated|Unable to adopt element handle from a different document/i.test(
      error.message,
    )
  )
    return 'observation_navigation_changed';
  if (
    /createTreeWalker.*(?:not of type|not a Node)|parameter 1 is not of type 'Node'/i.test(
      error.message,
    )
  )
    return 'observation_document_not_ready';
  if (/Target (?:page, context or browser|closed)|browser has been closed/i.test(error.message))
    return 'browser_closed';
  if (error.name === 'TimeoutError') return 'browser_observation_timeout';
  return 'browser_observation_failed';
}
export const transientObservation = (code: string) =>
  ['observation_navigation_changed', 'observation_document_not_ready'].includes(code);

export function errorNotice(error: unknown, phase: string): JobNotice {
  const code =
    error instanceof ServiceError && /^[a-z0-9_:-]{1,150}$/.test(error.code)
      ? error.code
      : 'unclassified_error';
  if (code === 'delegation_expired_or_changed')
    return {
      category: 'user',
      title: '사용자 확인 필요 · 작업 위임 갱신',
      reason: '이 작업의 24시간 위임이 만료되었거나 프로필·정책이 변경되어 재개를 멈췄습니다.',
      nextAction:
        '아래 위임 안내에서 현재 정책을 확인하고 「위임 갱신하고 현재 화면에서 재개」를 누르세요. 일반 재개 버튼만 반복해도 갱신되지는 않습니다.',
      code,
      phase,
      at: Date.now(),
    };
  if (
    [
      'expected_one_browser_step',
      'invalid_action_json',
      'invalid_action_schema',
      'model_output_refused',
      'invalid_response_output_stream',
    ].includes(code) &&
    (phase === 'model' || error instanceof ModelOutputError)
  )
    return {
      category: 'technical',
      title: '기술 오류 · AI 응답 확인 중단',
      reason:
        code === 'invalid_response_output_stream'
          ? '스트리밍 응답의 완료 항목이 누락되거나 서로 충돌합니다. 부분 명령을 실행하지 않습니다.'
          : code === 'model_output_refused'
            ? '모델이 응답을 거절했습니다. 자동 재요청하지 않습니다.'
            : 'AI 응답을 실행 명령으로 검증하지 못했습니다. 해당 동작은 실행하지 않았습니다.',
      nextAction:
        'AI 응답 검증 기록에서 동작 개수·형식·실패 항목과 재요청 결과를 확인하세요. 기존 제출 결과가 미확인인 경우 재제출하지 마세요.',
      code,
      phase,
      at: Date.now(),
    };
  if (code === 'storage_screenshot_limit')
    return {
      category: 'normal',
      title: '정상 중단 · 스크린샷 용량 상한',
      reason:
        '일반 자료를 정리해도 새 스크린샷을 저장할 공간이 부족합니다. 중요한 증거는 보호했습니다.',
      nextAction:
        '07 예약·운영의 저장 공간에서 보호·정리 내역을 확인하세요. 공간 확보 후 현재 화면에서 재개할 수 있습니다. 접수 결과 미확인 건은 재제출하지 마세요.',
      code,
      phase,
      at: Date.now(),
    };
  if (
    [
      'unsupported_numbered_choice',
      'form_widget_unsupported',
      'form_button_not_revealed',
      'form_local_input_limit',
    ].includes(code)
  )
    return {
      category: 'technical',
      title: '기술 오류 · 폼 조작 지원 필요',
      reason:
        code === 'form_button_not_revealed'
          ? '허용된 답변을 입력했지만 진행·제출 버튼이 나타나지 않았습니다. 입력을 반복하거나 제출하지 않았습니다.'
          : code === 'form_local_input_limit'
            ? '입력 후 진행 버튼을 찾는 단계가 반복되어 중단했습니다. 제출하지 않았습니다.'
            : '문항·선택 상태 또는 진행 버튼을 앱이 안전하게 연결하지 못했습니다. 로그인·인증 요청이 아닌 폼 조작 지원 문제입니다.',
      nextAction:
        '현재 화면과 입력은 보존합니다. 같은 재개를 반복하기보다 폼 지원을 보완하거나 수동 진행을 선택하세요. 직접 제출했다면 수동 완료로 기록하세요.',
      code,
      phase,
      at: Date.now(),
    };
  const normal =
    /^(?:discovery_(?:decision_limit|switch_limit|no_alternative)|selection_(?:call_limit|token_limit)|daily_.+|session_time_limit|budget_.+|unstable_source_recovery_limit)$/.test(
      code,
    );
  const user =
    /login|verification_required|auth_|oauth_|api_key|credential|consent|approval|delegation|account_not_identified|browser_reconnect|selection_changed|cost_rate_required|unreported_usage_requires_review|autonomy_live_page_required|final_review_changed|multiple_forms_require_manual_selection|privacy_notice_not_accepted|form_validation_failed/.test(
      code,
    );
  const messages: Record<string, string> = {
    form_button_missing:
      '현재 문항을 진행할 버튼을 인식하지 못했습니다. 기존 입력·첨부 상태를 확인한 뒤 재개하세요.',
    form_button_unselected:
      'AI 계획에 관찰한 진행 버튼이 연결되지 않았습니다. 입력·전송하지 않았습니다.',
    multiple_active_form_dialogs: '열린 팝업이 여러 개여서 응모 폼을 구별하지 못했습니다.',
    local_form_not_opened:
      '진행 버튼을 눌렀지만 예상한 개인정보 팝업을 확인하지 못했습니다. 전송은 차단했고 버튼을 반복하지 않습니다.',
    local_form_answers_changed:
      '팝업을 열기 전에 확인한 입력값이 바뀌었습니다. 제출하지 않았습니다.',
    form_observation_unstable:
      '문항 구조가 계속 바뀌어 안정된 화면을 확보하지 못했습니다. 입력·전송하지 않았습니다.',
    step_intent_missing: '다음 이동의 실행 기록을 현재 화면과 연결하지 못했습니다.',
    step_form_changed: '다음 이동 뒤 다른 폼이 표시되어 진행을 멈췄습니다.',
    step_network_unsettled_or_unmatched:
      '다음 이동과 연결된 서버 응답이 없거나 수집이 끝나지 않았습니다.',
    step_page_not_ready: '다음 이동 뒤 새 페이지의 경로를 아직 읽지 못했습니다.',
    step_path_not_advanced:
      '다음 이동 뒤 섹션 경로가 진행되지 않았습니다. 사이트의 입력 오류도 확인하세요.',
    step_controls_or_definition_unverified:
      '다음 섹션의 경로는 관찰했지만 문항·이동 버튼을 검증하지 못했습니다.',
    step_page_or_controls_unverified: '다음 페이지 번호·문항·이동 버튼을 함께 확인하지 못했습니다.',
    browser_observation_unstable:
      '화면 전환이 반복되어 두 번 다시 읽은 뒤에도 안정된 화면을 확보하지 못했습니다.',
    browser_observation_failed: '브라우저 화면을 읽는 중 분류되지 않은 오류가 발생했습니다.',
    browser_observation_timeout: '브라우저 화면 읽기 시간이 초과됐습니다.',
    browser_closed: '작업에 연결된 브라우저나 탭이 닫혔습니다.',
    browser_background_tab_failed:
      '배경 탭을 만들지 못했습니다. 창을 강제로 앞으로 열지 않고 중단했습니다. 기존 응모 화면은 보존합니다.',
    observation_target_changed: '관찰 중 작업 대상 탭이 바뀌어 기존 화면을 사용하지 않았습니다.',
    unclassified_error: '분류되지 않은 기술 오류로 작업을 중단했습니다.',
    ambiguous_form_questions:
      '서로 다른 문항을 구별하지 못해 입력 전에 멈췄습니다. 문항 인식의 기술 오류입니다.',
    ambiguous_form_options: '선택지의 연결을 명확히 구별하지 못해 입력을 중단했습니다.',
    unlabelled_custom_choice:
      '선택지와 질문 제목을 연결하지 못해 입력 전에 멈췄습니다. 문항 인식의 기술 오류입니다.',
    unsupported_choice_state: '선택지의 현재 선택 상태를 확인하지 못해 입력 전에 멈췄습니다.',
    form_controls_not_ready:
      '폼 선택지가 아직 로딩 중이어서 입력하지 않았습니다. 화면이 준비된 뒤 재개할 수 있습니다.',
    unsupported_google_dropdown:
      '구글폼 드롭다운의 질문·선택지를 명확히 연결하지 못해 입력 전에 멈췄습니다.',
    form_structure_changed: '입력 중 폼 구조가 달라졌고 허용된 자동 복구로 해결하지 못했습니다.',
    field_verification_failed: '입력 후 실제 값이나 선택 상태를 검증하지 못했습니다.',
    form_destination_outside_grant:
      '허용된 출처 안에서 제출 대상을 확인하지 못해 전송하지 않았습니다.',
    autonomy_live_page_required:
      '작성 중인 원래 화면이 필요합니다. 새 페이지로 되돌려 다시 전송하지 않았습니다.',
    final_review_changed:
      '최종 검토 이후 입력 내용이나 질문이 바뀌어 기존 제출 승인을 사용하지 않았습니다.',
    form_validation_failed: '사이트의 입력 검사에서 누락 또는 형식 오류가 발견됐습니다.',
  };
  return {
    category: normal ? 'normal' : user ? 'user' : 'technical',
    title: normal
      ? '정상 중단 · 조건·한도 확인'
      : user
        ? '사용자 확인 필요'
        : '기술 오류 · 작업 중단',
    reason: messages[code] || safeMessage(error),
    nextAction: normal
      ? '중단 조건과 남은 한도를 확인하세요. 이 기록을 보관하거나 다른 후보를 선택할 수 있습니다.'
      : user
        ? '연결 또는 확인함의 요청을 처리한 뒤 재개하세요.'
        : phase.startsWith('form_')
          ? phase === 'form_transition'
            ? '현재 화면에서 재개하면 이동 결과만 다시 관찰합니다. 다음 버튼을 자동 재전송하지 않으며 최종 접수 판정과는 별개입니다.'
            : '문항 인식·입력 오류 기록을 확인하세요. 미제출 작업은 수정 후 남은 한도로 기존 화면에서 재개할 수 있습니다. 직접 제출했다면 재개하지 말고 수동 완료로 기록하세요.'
          : '원인 기록을 확인하세요. 탐색은 남은 한도로 새 화면에서 재개할 수 있습니다. 같은 오류가 반복되면 이 기록을 보관하세요.',
    code,
    phase,
    at: Date.now(),
  };
}

export function jobNotice(job: Job): JobNotice | undefined {
  if (pendingFormStep(job) && job.formExecution && !['running', 'queued'].includes(job.status))
    return {
      ...errorNotice(
        new ServiceError(
          job.formExecution.transition?.reason || 'step_page_or_controls_unverified',
        ),
        'form_transition',
      ),
      title: '기술 오류 · 다음 페이지 관찰 대기',
    };
  if (
    (job.uncertain || job.status === 'submission_unknown') &&
    job.intent?.kind === 'step' &&
    job.intent.providerControl === 'google-next'
  )
    return {
      category: 'technical',
      title: '기술 오류 · 다음 단계 확인 중단',
      reason:
        '다음 이동 후 새 문항을 확인하지 못했습니다. 최종 응모의 접수 실패를 뜻하지 않습니다.',
      nextAction:
        '현재 브라우저 화면에서 재개하면 페이지 경로와 문항을 다시 확인합니다. 확인 전에는 자동 재전송하지 않습니다.',
      code: 'form_step_unverified',
      phase: 'form_navigation',
      at: job.intent.at,
    };
  if ((job.uncertain || job.status === 'submission_unknown') && job.receiptCheck?.captureIncomplete)
    return {
      category: 'technical',
      title: '기술 오류 · 접수 관찰 미완료',
      reason: job.receiptCheck.reason,
      nextAction: '저장된 접수 증거만 다시 확인하세요. 입력·제출을 재실행하지 않습니다.',
      code: 'receipt_capture_incomplete',
      phase: 'form_receipt',
      at: job.receiptCheck.at,
    };
  const capture = job.receiptCheck?.capture;
  if (
    (job.uncertain || job.status === 'submission_unknown') &&
    capture &&
    capture.observedPosts > 0 &&
    capture.matchedRequests === 0 &&
    (capture.rejected.payload_mismatch || capture.rejected.unsupported_body)
  )
    return {
      category: 'technical',
      title: '기술 오류 · 제출 응답 연결 실패',
      reason:
        '브라우저의 전송 요청을 승인된 답변과 연결하지 못해 서버 응답을 접수 증거로 저장하지 못했습니다. 실제 응모 실패를 뜻하지 않습니다.',
      nextAction:
        '추가 답변이나 재제출은 하지 마세요. 남아 있는 화면·접수 기록으로 확인하거나 미확인 상태로 보관하세요. 저장하지 못한 과거 서버 응답은 자동 복원할 수 없습니다.',
      code: 'receipt_request_unbound',
      phase: 'form_receipt',
      at: job.receiptCheck!.at,
    };
  if (job.uncertain || job.status === 'submission_unknown')
    return {
      category: 'user',
      title: '사용자 확인 필요 · 접수 결과 미확인',
      reason: job.note,
      nextAction: '저장된 접수 증거를 확인하세요. 중복 제출 방지를 위해 자동 재시도하지 않습니다.',
    };
  if (['running', 'queued', 'completed'].includes(job.status)) return;
  if (job.stopReason?.code === 'delegation_expired_or_changed')
    return {
      ...errorNotice(
        new ServiceError(job.stopReason.code),
        job.stopReason.phase || 'form_navigation',
      ),
      at: job.stopReason.at,
    };
  if (job.stopReason) return job.stopReason;
  if (
    job.tasks?.some(
      (t) =>
        t.draftPreparation?.failureKind === 'read_control' &&
        t.draftPreparation.state === 'needs_input' &&
        !t.approval &&
        !t.attempt,
    )
  )
    return {
      category: 'technical',
      title: '기술 오류 · 댓글 근거 읽기 중단',
      code: 'comment_read_control_unsupported',
      phase: 'comment_draft',
      reason: job.note,
      nextAction:
        '이미지·본문 읽기 지원과 거절 기록을 확인하세요. 수정 후 기존 작업을 재개할 수 있으며, 승인 전에는 댓글을 게시하지 않습니다.',
    };
  if (
    job.status === 'needs_user' &&
    /^(ambiguous_form_questions|ambiguous_form_options|form_structure_changed|field_verification_failed)$/.test(
      job.note,
    )
  )
    return { ...errorNotice(new ServiceError(job.note), 'form_legacy'), at: undefined };
  const diagnostic = job.observationDiagnostics?.at(-1);
  if (
    diagnostic?.outcome === 'stopped' &&
    job.status === 'needs_user' &&
    [safeMessage(new ServiceError(diagnostic.code)), 'browser_observation_unstable'].includes(
      job.note,
    ) &&
    /^browser_observation_|^observation_|^browser_closed$/.test(diagnostic.code)
  )
    return {
      ...errorNotice(
        new ServiceError(
          transientObservation(diagnostic.code) ? 'browser_observation_unstable' : diagnostic.code,
        ),
        `observation:${diagnostic.stage}`,
      ),
      at: diagnostic.at,
    };
  if (
    job.status === 'failed' ||
    job.note === '작업을 완료하지 못했습니다. 연결 상태와 실행 기록을 확인해 주세요.'
  )
    return {
      ...errorNotice(new Error(), 'unknown'),
      code: 'legacy_error_without_diagnostics',
      at: undefined,
      reason:
        '기술 오류로 중단됐지만 당시 세부 원인은 기록되지 않았습니다. 조건 불일치나 한도 소진으로 확정된 상태가 아닙니다.',
    };
  if (['paused', 'stopped'].includes(job.status))
    return {
      category: 'normal',
      title: '정상 중단 · 일시정지/조건/한도',
      reason:
        job.status === 'stopped' &&
        job.note === '브라우저를 직접 조작할 수 있습니다. 재개 시 새 화면부터 확인합니다.'
          ? '작업을 중지했습니다. 추가 답변이나 재개 없이 실행 기록만 보관합니다.'
          : job.note,
      nextAction:
        job.status === 'stopped'
          ? '중지한 기록입니다. 필요한 경우 기회 목록에서 처리 방법을 선택하세요.'
          : '일시정지 이유와 남은 한도를 확인한 뒤 재개하거나 보관하세요.',
    };
  return {
    category: 'user',
    title: '사용자 확인 필요',
    reason: job.note,
    nextAction:
      job.autonomy?.inbox || job.approval || job.tasks?.some((t) => t.state === 'review')
        ? '아래 확인함에서 필요한 답변·동의·대상을 확인하고 계속 진행하세요.'
        : '요청된 실제 정보나 로그인·인증을 확인한 뒤 현재 화면에서 재개하세요.',
  };
}
