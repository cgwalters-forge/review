// The hook for a chat in the "Ask anything" box atop the page.
//
// Nothing is mounted yet: the box only files notes onto the board (see
// captureview.ts). A chat would implement ChatPanel, be returned by
// chatPanel(), and main.ts then mounts it into the #chat slot beside the
// capture bar, shown for the signed-in operator only.

export interface ChatPanel {
  /** Fill `slot`, which is the box's #chat element. */
  mount(slot: HTMLElement): void;
}

/** The chat to mount, if there is one. */
export function chatPanel(): ChatPanel | undefined {
  return undefined;
}
