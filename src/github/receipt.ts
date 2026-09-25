// Verify a draft item's answer receipt: a gist that only its owner can
// have written. The bot applies the same rules (plus a check that the
// receipt is newer than the question); the app uses them to show an
// answer as verified rather than merely claimed by the draft body.

import { parseReceipt, type Receipt } from "../answer.ts";

/** The one file a receipt holds. */
export const RECEIPT_FILE = "answer.md";

/** The subset of GET /gists/{id} the check reads. */
export interface RawReceiptGist {
  html_url?: string;
  owner?: { login?: string } | null;
  fork_of?: unknown;
  history?: { user?: { login?: string } | null }[];
  files?: Record<string, { filename?: string; truncated?: boolean; content?: string } | null>;
}

export type ReceiptCheck = { ok: true; receipt: Receipt } | { ok: false; reason: string };

/**
 * Check a receipt fetched by id (never trust the user in its URL):
 * owned and only ever edited by `operator`, not a fork, exactly one
 * untruncated answer.md that parses, for this item and with this
 * question's id (or none when the question has none).
 */
export function checkReceipt(
  gist: RawReceiptGist,
  itemId: string,
  operator: string,
  question: string | undefined,
): ReceiptCheck {
  const fail = (reason: string): ReceiptCheck => ({ ok: false, reason });
  const owner = gist.owner?.login;
  if (owner !== operator) return fail(`the receipt belongs to ${owner ?? "nobody"}, not ${operator}`);
  if (gist.fork_of !== undefined && gist.fork_of !== null) return fail("the receipt is a fork of another gist");
  const history = gist.history ?? [];
  if (history.length !== 1) return fail(`the receipt has ${history.length} revisions; a receipt is never edited`);
  if (history[0]?.user?.login !== operator) return fail(`the receipt's revision is not by ${operator}`);
  const names = Object.keys(gist.files ?? {});
  if (names.length !== 1 || names[0] !== RECEIPT_FILE) return fail(`the receipt must hold exactly ${RECEIPT_FILE}`);
  const file = gist.files?.[RECEIPT_FILE];
  if (!file || file.truncated || typeof file.content !== "string") return fail("the receipt's content is truncated or missing");
  const receipt = parseReceipt(file.content);
  if (!receipt) return fail("the receipt is not an answer");
  if (receipt.item !== itemId) return fail(`the receipt answers another item (${receipt.item})`);
  // Ids must agree both ways: an id on an answer to a question without
  // one is an answer to some other question.
  if (receipt.question !== question) {
    return fail(
      question === undefined
        ? `the receipt answers ${receipt.question}, but the question has no id`
        : `the receipt answers ${receipt.question ?? "a question without an id"}, not ${question}`,
    );
  }
  return { ok: true, receipt };
}
