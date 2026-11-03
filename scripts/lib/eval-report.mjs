// The eval run's all-in-one transcript (all.md), built apart from the runner so a test can check it.

/** The header and every scenario's transcript, as one Markdown document (a string, for writeFileSync). */
export function allReport(at, pathLabel, transcripts) {
  return [`# Eval run ${at} (path: ${pathLabel})`, "", ...transcripts].join("\n");
}

/**
 * Runs a post to the simulator, once more after a network-level failure ("fetch failed": a socket
 * closed or refused), never after anything else. Safe only for posts that carry their own operation
 * key or message ID, so a second try can't count twice. A failure that stays says its cause.
 */
export async function retriedOnce(post, waitMs = 1_000) {
  try {
    return await post();
  } catch (first) {
    if (!(first instanceof TypeError)) throw first;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      return await post();
    } catch (second) {
      if (!(second instanceof TypeError)) throw second;
      const cause = second.cause?.code ?? second.cause?.message ?? "no cause";
      throw new TypeError(`${second.message} (${cause})`, { cause: second.cause });
    }
  }
}
