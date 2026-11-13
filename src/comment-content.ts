import { z } from 'zod';

const Id = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
// Public copy and questions for the owner are separate data, never one prompt to paste.
export const CommentPlanSchema = z
  .object({
    parts: z
      .array(
        z.union([
          z.object({ text: z.string().max(2000) }).strict(),
          z
            .object({ inputId: Id, prefix: z.string().max(120), suffix: z.string().max(120) })
            .strict(),
        ]),
      )
      .min(1)
      .max(16),
    inputs: z
      .array(
        z
          .object({
            id: Id,
            label: z.string().min(1).max(400),
            kind: z.enum(['choice', 'text']),
            options: z
              .array(
                z
                  .object({
                    id: Id,
                    label: z.string().min(1).max(300),
                    text: z.string().min(1).max(600),
                  })
                  .strict(),
              )
              .max(12),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export type CommentPlan = z.infer<typeof CommentPlanSchema>;

export function commentContentProblem(text: string) {
  const value = text
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ');
  if (
    /(?:게시\s*문구|작업별|위임)\s*(?:승인|정책)|저장된.{0,35}(?:정책|확인.{0,8}요청)/i.test(
      value,
    ) ||
    /(?:대시보드|확인함).{0,60}(?:눌러|누르|확인해|검토해|입력해|처리해|재개|승인)/i.test(value) ||
    /(?:한 번에 답변하고 재개|과제 확인을 한 번에 저장하고 계속|최종 제출하고 결과 확인)/.test(
      value,
    ) ||
    /(?:saved|delegation|per.task).{0,25}(?:approval policy|posting approval)|(?:dashboard|inbox).{0,40}(?:click|approve|review)/i.test(
      value,
    )
  )
    return 'comment_contains_guidance';
  if (/\{\{[^{}]+\}\}|\[(?:입력|선택|개인 의견|답변 필요)[^\]]*\]/i.test(value))
    return 'comment_unresolved_placeholder';
  return undefined;
}

export function commentPlanProblem(plan: CommentPlan) {
  const ids = plan.inputs.map((i) => i.id);
  if (new Set(ids).size !== ids.length) return 'comment_plan_invalid';
  const refs = plan.parts.flatMap((p) => ('inputId' in p ? [p.inputId] : []));
  if (refs.length !== ids.length || ids.some((id) => refs.filter((r) => r === id).length !== 1))
    return 'comment_plan_invalid';
  for (const input of plan.inputs) {
    if (input.kind === 'choice' ? input.options.length < 2 : input.options.length !== 0)
      return 'comment_plan_invalid';
    if (new Set(input.options.map((o) => o.id)).size !== input.options.length)
      return 'comment_plan_invalid';
  }
  const copy =
    plan.parts.map((p) => ('text' in p ? p.text : p.prefix + p.suffix)).join('') +
    plan.inputs.flatMap((i) => i.options.map((o) => o.text)).join(' ');
  return commentContentProblem(copy);
}

export function commentPartText(
  plan: CommentPlan,
  part: CommentPlan['parts'][number],
  answers: Record<string, string>,
) {
  if ('text' in part) return part.text;
  const input = plan.inputs.find((i) => i.id === part.inputId);
  const answer = Object.hasOwn(answers, part.inputId) ? answers[part.inputId]?.trim() : undefined;
  const text = input?.kind === 'choice' ? input.options.find((o) => o.id === answer)?.text : answer;
  return text ? part.prefix + text + part.suffix : '';
}
export function composeComment(plan: CommentPlan, answers: Record<string, string> = {}) {
  return plan.parts
    .map((p) => commentPartText(plan, p, answers))
    .join('')
    .trim();
}
export function commentAnswersProblem(
  plan: CommentPlan,
  answers: Record<string, string>,
  text: string,
) {
  if (
    commentPlanProblem(plan) ||
    Object.keys(answers).some((id) => !plan.inputs.some((i) => i.id === id))
  )
    return 'comment_plan_invalid';
  for (const part of plan.parts) {
    if (!('inputId' in part)) continue;
    const segment = commentPartText(plan, part, answers).trim();
    if (!segment) return 'comment_personal_answer_required';
    if (!text.includes(segment)) return 'comment_personal_answer_mismatch';
  }
  return commentContentProblem(text);
}
