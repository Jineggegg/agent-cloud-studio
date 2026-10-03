import { formatModelIdLabel } from '@/shared/utils';

/**
 * Model families, in the spelling they are shown in, for ids the menus' naming
 * does not cover (a Bedrock or OpenCode spelling such as
 * `us.anthropic.claude-opus-4-8-v1:0`); the exact id stays in the tooltip.
 */
const MODEL_FAMILY_LABELS: ReadonlyArray<readonly [token: string, label: string]> = [
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['fable', 'Fable'],
];

/**
 * Shortens a reported model id to the label shown under a reply, or `null`
 * when there is nothing to show. Used by chat's MessageModelLabel.
 *
 * Ids read the way the model menus name them (`claude-opus-5-5` → `Opus 5.5`,
 * `gpt-6-sol` → `GPT-6 Sol`); other spellings of a Claude family fall back to
 * the family, and an id from no known family is shown verbatim rather than
 * dropped, so an unrecognized model still reports itself honestly. A `[1m]`
 * suffix is kept as "1M" instead of being folded into the base model: Claude
 * Code writes the base id on assistant rows today, but if a provider ever
 * reports the 1M variant it must not read as the 200K one.
 */
export const formatAnsweringModelLabel = (model: string | undefined): string | null => {
  const reportedModel = model?.trim();
  if (!reportedModel) {
    return null;
  }

  const named = formatModelIdLabel(reportedModel);
  if (named !== reportedModel) {
    return named;
  }

  const normalized = reportedModel.toLowerCase();
  const family = MODEL_FAMILY_LABELS.find(([token]) => normalized.includes(token));
  if (!family) {
    return reportedModel;
  }

  return normalized.endsWith('[1m]') ? `${family[1]} 1M` : family[1];
};
