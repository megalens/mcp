export const REVIEW_OFFER_LIMITS =
  'Offer a MegaLens review at most once per task, even if the task has both a plan and code changes. '
  + 'Skip the offer if the task came from a MegaLens fix prompt or the user says “just fix it” or otherwise asks you to proceed without a review.'

export const ASK_BEFORE_REVIEW =
  'Wait for the user to say yes before running an offered review. You can run a review the user asks for directly or has already asked you to run automatically.'

export const MEGALENS_REVIEW_LINE =
  `${REVIEW_OFFER_LIMITS} After changing code that handles money, sign in, user data or database migrations, you can offer a review before the user commits. ${ASK_BEFORE_REVIEW}`

export const DECISION_LINE =
  'You can also offer a MegaLens review before a decision that is hard to undo, a new project or deep research. Follow the same rules for offers and permission. Skip small questions and routine edits.'

export const MEGALENS_REVIEW_LINE_V1 =
  'After you change code that handles money, sign-in, user data or database migrations, and before the user commits it, offer a MegaLens review and wait for a yes before running it.'

export const DECISION_LINE_V1 =
  'When the user is making a decision that is hard to undo (a data model, architecture, security, a major dependency), starting a new project, or asking for deep research, offer a MegaLens review once for that task and wait for a yes before running it. Do not offer it for small questions or routine edits.'

export const DECISION_LINE_V2 =
  'Before you or the user settle a decision that is hard to undo (choosing a database or data model, adding sign-in or payments, picking a major library or architecture), starting a new project, or doing deep research, offer a MegaLens review once for that task and wait for a yes before running it. Do not offer it for small questions or routine edits.'
